//! Small semantic TTML/IMSC bridge used by the native DASH subtitle path.
//!
//! XML tokenization/entity handling is delegated to quick-xml.  The code here
//! resolves TTML timing, style and region semantics into renderer-neutral cues;
//! it is intentionally not an XML/tag-stripping subtitle converter.

use crate::dash_timeline::ExactTime;
use quick_xml::{events::Event, Reader};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct TextStyle {
    pub font_family: Option<String>, pub font_size: Option<String>, pub font_weight: Option<String>,
    pub font_style: Option<String>, pub color: Option<String>, pub background_color: Option<String>,
    pub opacity: Option<String>, pub text_decoration: Option<String>, pub line_height: Option<String>,
    pub text_align: Option<String>, pub writing_mode: Option<String>, pub ruby: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct Region { pub id:String, pub origin:Option<String>, pub extent:Option<String>, pub display_align:Option<String>, pub style:TextStyle }

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StyledSpan { pub text:String, pub style:TextStyle }

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TextCue { pub start:ExactTime, pub end:ExactTime, pub region:Option<Region>, pub style:TextStyle, pub spans:Vec<StyledSpan>, pub unsupported:Vec<String> }

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BitmapCue { pub start:ExactTime, pub end:ExactTime, pub region:Option<Region>, pub viewport:BitmapViewport, pub opacity:Option<String>, pub mime_type:String, pub encoded_image:Vec<u8> }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct BitmapViewport { pub x:u32, pub y:u32, pub width:u32, pub height:u32 }

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ParsedCue { Text(TextCue), Bitmap(BitmapCue) }

#[derive(Clone, Debug, Default)] struct Node { name:String, attrs:HashMap<String,String>, children:Vec<Child> }
#[derive(Clone, Debug)] enum Child { Node(Node), Text(String), Break }

#[derive(Clone, Copy)] struct Timing { frame_rate:u64, sub_frame_rate:u64, tick_rate:u64 }
impl Default for Timing { fn default()->Self{Self{frame_rate:30,sub_frame_rate:1,tick_rate:1}} }

fn local(value:&[u8])->String { String::from_utf8_lossy(value).rsplit(':').next().unwrap_or_default().to_string() }
fn attr<'a>(node:&'a Node,name:&str)->Option<&'a str>{node.attrs.get(name).map(String::as_str)}

fn xml_tree(xml:&[u8])->Result<Node,String>{
    let mut reader=Reader::from_reader(xml);reader.config_mut().trim_text(false);let mut stack=Vec::<Node>::new();let mut root=None;let mut buf=Vec::new();
    loop{match reader.read_event_into(&mut buf).map_err(|e|format!("TTML XML parse failed: {e}"))?{
        Event::Start(e)=>{let mut node=Node{name:local(e.name().as_ref()),..Node::default()};for a in e.attributes().with_checks(true){let a=a.map_err(|e|format!("TTML XML attribute failed: {e}"))?;let key=local(a.key.as_ref());let value=a.decode_and_unescape_value(reader.decoder()).map_err(|e|format!("TTML XML attribute failed: {e}"))?.into_owned();node.attrs.insert(key,value);}stack.push(node)}
        Event::Empty(e)=>{let mut node=Node{name:local(e.name().as_ref()),..Node::default()};for a in e.attributes().with_checks(true){let a=a.map_err(|e|format!("TTML XML attribute failed: {e}"))?;let key=local(a.key.as_ref());let value=a.decode_and_unescape_value(reader.decoder()).map_err(|e|format!("TTML XML attribute failed: {e}"))?.into_owned();node.attrs.insert(key,value);}if node.name=="br"{if let Some(p)=stack.last_mut(){p.children.push(Child::Break)}}else if let Some(p)=stack.last_mut(){p.children.push(Child::Node(node))}else{root=Some(node)}}
        Event::Text(e)=>{if let Some(p)=stack.last_mut(){let value=e.unescape().map_err(|e|format!("TTML XML text failed: {e}"))?.into_owned();p.children.push(Child::Text(value))}}
        Event::CData(e)=>{if let Some(p)=stack.last_mut(){p.children.push(Child::Text(String::from_utf8_lossy(e.as_ref()).into_owned()))}}
        Event::End(_)=>{let node=stack.pop().ok_or("TTML XML structure invalid")?;if let Some(p)=stack.last_mut(){p.children.push(Child::Node(node))}else if node.name=="tt"{return Ok(node)}else{root=Some(node)}}
        Event::Eof=>break,_=>{}}
        buf.clear();
    }
    root.filter(|r|r.name=="tt").ok_or_else(||"TTML document has no tt root".into())
}

fn decimal(value:&str)->Result<ExactTime,String>{let neg=value.starts_with('-');let v=value.trim_start_matches(['+','-']);let(mut whole,mut scale)=(v,1u64);let mut combined=v.to_string();if let Some((a,b))=v.split_once('.') {whole=a;scale=10u64.checked_pow(b.len() as u32).ok_or("TTML time overflow")?;combined=format!("{a}{b}")}let _=whole;let mut n=combined.parse::<i128>().map_err(|_|"Invalid TTML decimal")?;if neg{n=-n}ExactTime::new(n,scale).map_err(|_|"TTML time overflow".into())}
fn mul(value:ExactTime,factor:i128)->Result<ExactTime,String>{ExactTime::new(value.numerator().checked_mul(factor).ok_or("TTML time overflow")?,value.denominator()).map_err(|_|"TTML time overflow".into())}
fn div(value:ExactTime,factor:u64)->Result<ExactTime,String>{ExactTime::new(value.numerator(),value.denominator().checked_mul(factor).ok_or("TTML time overflow")?).map_err(|_|"TTML time overflow".into())}

fn parse_time_expression(value:&str,t:Timing)->Result<ExactTime,String>{
    let v=value.trim();
    if v.contains(':'){
        let parts=v.split(':').collect::<Vec<_>>();if parts.len()!=3&&parts.len()!=4{return Err("Unsupported TTML clock time".into())}
        let h=parts[0].parse::<i128>().map_err(|_|"Invalid TTML clock time")?;let m=parts[1].parse::<i128>().map_err(|_|"Invalid TTML clock time")?;let sec=decimal(parts[2])?;let mut out=ExactTime::new(h.checked_mul(3600).and_then(|x|m.checked_mul(60).and_then(|y|x.checked_add(y))).ok_or("TTML time overflow")?,1).map_err(|_|"TTML time overflow")?.checked_add(sec).map_err(|_|"TTML time overflow")?;
        if parts.len()==4{let(frames,sub)=parts[3].split_once('.').unwrap_or((parts[3],"0"));let f=frames.parse::<i128>().map_err(|_|"Invalid TTML frame time")?;out=out.checked_add(ExactTime::new(f,t.frame_rate).map_err(|_|"TTML time overflow")?).map_err(|_|"TTML time overflow")?;if sub!="0"{out=out.checked_add(ExactTime::new(sub.parse::<i128>().map_err(|_|"Invalid TTML subframe time")?,t.frame_rate.checked_mul(t.sub_frame_rate).ok_or("TTML time overflow")?).map_err(|_|"TTML time overflow")?).map_err(|_|"TTML time overflow")?}return Ok(out)}return Ok(out)
    }
    for suffix in ["ms","h","m","s","f","t"]{if let Some(number)=v.strip_suffix(suffix){let x=decimal(number)?;return match suffix{"ms"=>div(x,1000),"h"=>mul(x,3600),"m"=>mul(x,60),"s"=>Ok(x),"f"=>div(x,t.frame_rate),"t"=>div(x,t.tick_rate),_=>unreachable!()}}}
    Err("Unsupported TTML time expression".into())
}

fn style_values(node:&Node)->TextStyle{let get=|n:&str|attr(node,n).map(str::to_string);TextStyle{font_family:get("fontFamily"),font_size:get("fontSize"),font_weight:get("fontWeight"),font_style:get("fontStyle"),color:get("color"),background_color:get("backgroundColor"),opacity:get("opacity"),text_decoration:get("textDecoration"),line_height:get("lineHeight"),text_align:get("textAlign"),writing_mode:get("writingMode"),ruby:get("ruby")}}
fn overlay(base:&mut TextStyle,top:&TextStyle){macro_rules! f{($x:ident)=>{if top.$x.is_some(){base.$x=top.$x.clone()}}}f!(font_family);f!(font_size);f!(font_weight);f!(font_style);f!(color);f!(background_color);f!(opacity);f!(text_decoration);f!(line_height);f!(text_align);f!(writing_mode);f!(ruby);}
fn walk<'a>(node:&'a Node,name:&str,out:&mut Vec<&'a Node>){if node.name==name{out.push(node)}for c in &node.children{if let Child::Node(n)=c{walk(n,name,out)}}}
fn resolve_style(id:&str,styles:&HashMap<String,Node>,seen:&mut HashSet<String>)->TextStyle{if !seen.insert(id.to_string()){return TextStyle::default()}let Some(n)=styles.get(id)else{return TextStyle::default()};let mut out=TextStyle::default();if let Some(refs)=attr(n,"style"){for r in refs.split_whitespace(){overlay(&mut out,&resolve_style(r,styles,seen))}}overlay(&mut out,&style_values(n));out}
fn applied_style(node:&Node,parent:&TextStyle,styles:&HashMap<String,Node>)->TextStyle{let mut out=parent.clone();if let Some(ids)=attr(node,"style"){for id in ids.split_whitespace(){overlay(&mut out,&resolve_style(id,styles,&mut HashSet::new()))}}overlay(&mut out,&style_values(node));out}
fn collect_spans(node:&Node,parent:&TextStyle,styles:&HashMap<String,Node>,out:&mut Vec<StyledSpan>){let style=applied_style(node,parent,styles);for c in &node.children{match c{Child::Text(s)=>{if !s.is_empty(){out.push(StyledSpan{text:s.clone(),style:style.clone()})}},Child::Break=>out.push(StyledSpan{text:"\n".into(),style:style.clone()}),Child::Node(n)=>collect_spans(n,&style,styles,out)}}}
fn find_path<'a>(node:&'a Node,target:*const Node,path:&mut Vec<&'a Node>)->bool{if std::ptr::eq(node,target){return true}for c in &node.children{if let Child::Node(n)=c{path.push(node);if find_path(n,target,path){return true}path.pop();}}false}
fn inherited_attr<'a>(ancestors:&[&'a Node],node:&'a Node,name:&str)->Option<&'a str>{attr(node,name).or_else(||ancestors.iter().rev().find_map(|n|attr(n,name)))}

fn node_time(node:&Node,timing:Timing)->Result<(Option<ExactTime>,Option<ExactTime>),String>{let start=attr(node,"begin").map(|v|parse_time_expression(v,timing)).transpose()?;let mut end=attr(node,"end").map(|v|parse_time_expression(v,timing)).transpose()?;if end.is_none(){if let Some(dur)=attr(node,"dur"){let base=start.unwrap_or(ExactTime::ZERO);end=Some(base.checked_add(parse_time_expression(dur,timing)?).map_err(|_|"TTML time overflow")?)}}Ok((start,end))}
fn resolved_time(node:&Node,ancestors:&[&Node],timing:Timing)->Result<(ExactTime,ExactTime),String>{let(mut start,mut end)=node_time(node,timing)?;for parent in ancestors.iter().rev().take_while(|n|n.name!="tt"){let(ps,pe)=node_time(parent,timing)?;start=match(start,ps){(Some(v),Some(p))=>Some(v.checked_add(p).map_err(|_|"TTML time overflow")?),(None,p)=>p,(v,None)=>v};end=match(end,ps,pe){(Some(v),Some(p),_)=>Some(v.checked_add(p).map_err(|_|"TTML time overflow")?),(None,_,p)=>p,(v,None,_)=>v};}Ok((start.unwrap_or(ExactTime::ZERO),end.ok_or("TTML cue has no end/dur")?))}
fn numeric_pair(value:&str,suffix:&str)->Option<(f64,f64)>{let p=value.split_whitespace().collect::<Vec<_>>();if p.len()!=2{return None}Some((p[0].strip_suffix(suffix)?.parse().ok()?,p[1].strip_suffix(suffix)?.parse().ok()?))}
fn bitmap_viewport(region:Option<&Region>,root_extent:Option<(f64,f64)>,cell:(f64,f64))->BitmapViewport{let pair=|v:Option<&str>,default:(f64,f64),is_extent:bool|->(f64,f64){let Some(v)=v else{return default};if let Some(p)=numeric_pair(v,"%"){return(p.0/100.0,p.1/100.0)}if let(Some(p),Some(root))=(numeric_pair(v,"px"),root_extent){return(p.0/root.0,p.1/root.1)}if let Some(p)=numeric_pair(v,"c"){return(p.0/cell.0,p.1/cell.1)}if is_extent{default}else{(0.0,0.0)}};let(x,y)=pair(region.and_then(|r|r.origin.as_deref()),(0.0,0.0),false);let(w,h)=pair(region.and_then(|r|r.extent.as_deref()),(1.0-x,1.0-y),true);let ppm=|v:f64|(v.clamp(0.0,1.0)*1_000_000.0).round()as u32;BitmapViewport{x:ppm(x),y:ppm(y),width:ppm(w.min(1.0-x)),height:ppm(h.min(1.0-y))}}
fn node_text(node:&Node)->String{node.children.iter().filter_map(|c|if let Child::Text(s)=c{Some(s.as_str())}else{None}).collect()}
fn embedded_images(root:&Node)->HashMap<String,(String,Vec<u8>)>{let mut nodes=Vec::new();walk(root,"image",&mut nodes);nodes.into_iter().filter_map(|n|{let id=attr(n,"id")?;let kind=attr(n,"imageType").or_else(||attr(n,"imagetype")).or_else(||attr(n,"type")).unwrap_or("PNG");let mime=if kind.eq_ignore_ascii_case("PNG"){"image/png"}else if kind.eq_ignore_ascii_case("JPEG")||kind.eq_ignore_ascii_case("JPG"){"image/jpeg"}else{kind};let encoded=node_text(n).split_whitespace().collect::<String>();let data=base64::Engine::decode(&base64::engine::general_purpose::STANDARD,encoded).ok()?;Some((id.into(),(mime.into(),data)))}).collect()}
fn appended_pngs(sample:&[u8])->Vec<Vec<u8>>{const SIG:&[u8]=b"\x89PNG\r\n\x1a\n";let mut out=Vec::new();let mut at=0;while let Some(rel)=sample[at..].windows(SIG.len()).position(|w|w==SIG){let start=at+rel;let mut pos=start+8;let mut end=None;while pos+12<=sample.len(){let len=u32::from_be_bytes(sample[pos..pos+4].try_into().unwrap())as usize;if pos+12+len>sample.len(){break}if &sample[pos+4..pos+8]==b"IEND"{end=Some(pos+12+len);break}pos+=12+len}let Some(stop)=end else{break};out.push(sample[start..stop].to_vec());at=stop}out}

pub(crate) fn parse_document(sample:&[u8])->Result<Vec<ParsedCue>,String>{
    let root=xml_tree(sample)?;let mut timing=Timing::default();if let Some(v)=attr(&root,"frameRate"){timing.frame_rate=v.parse().map_err(|_|"Invalid TTML frameRate")?}if let Some(v)=attr(&root,"frameRateMultiplier"){let p=v.split_whitespace().map(str::parse::<u64>).collect::<Result<Vec<_>,_>>().map_err(|_|"Invalid TTML frameRateMultiplier")?;if p.len()!=2||p[1]==0{return Err("Invalid TTML frameRateMultiplier".into())}timing.frame_rate=timing.frame_rate.checked_mul(p[0]).ok_or("TTML time overflow")?/p[1]}if let Some(v)=attr(&root,"subFrameRate"){timing.sub_frame_rate=v.parse().map_err(|_|"Invalid TTML subFrameRate")?}if let Some(v)=attr(&root,"tickRate"){timing.tick_rate=v.parse().map_err(|_|"Invalid TTML tickRate")?}
    let root_extent=attr(&root,"extent").and_then(|v|numeric_pair(v,"px"));let cell=attr(&root,"cellResolution").and_then(|v|numeric_pair(v,"")).unwrap_or((32.0,15.0));
    let mut style_nodes=Vec::new();walk(&root,"style",&mut style_nodes);let styles=style_nodes.into_iter().filter_map(|n|attr(n,"id").map(|id|(id.to_string(),n.clone()))).collect::<HashMap<_,_>>();
    let mut region_nodes=Vec::new();walk(&root,"region",&mut region_nodes);let regions=region_nodes.into_iter().filter_map(|n|attr(n,"id").map(|id|(id.to_string(),Region{id:id.into(),origin:attr(n,"origin").map(str::to_string),extent:attr(n,"extent").map(str::to_string),display_align:attr(n,"displayAlign").map(str::to_string),style:applied_style(n,&TextStyle::default(),&styles)}))).collect::<HashMap<_,_>>();
    let embedded=embedded_images(&root);let side_images=appended_pngs(sample);let mut candidates=Vec::new();walk(&root,"p",&mut candidates);let mut divs=Vec::new();walk(&root,"div",&mut divs);candidates.extend(divs.into_iter().filter(|n|attr(n,"backgroundImage").or_else(||attr(n,"image")).is_some()));let mut cues=Vec::new();
    for node in candidates{let mut ancestors=Vec::new();find_path(&root,node as *const Node,&mut ancestors);let(begin,end)=resolved_time(node,&ancestors,timing)?;if end<=begin{continue}let mut inherited=TextStyle::default();for n in &ancestors{inherited=applied_style(n,&inherited,&styles)}let style=applied_style(node,&inherited,&styles);let region=inherited_attr(&ancestors,node,"region").and_then(|id|regions.get(id)).cloned();
        if let Some(reference)=attr(node,"backgroundImage").or_else(||attr(node,"image")){let resource=if let Some(id)=reference.strip_prefix('#'){embedded.get(id).cloned().ok_or("Unsupported IMSC image resource: missing embedded image")?}else if let Some(index)=reference.strip_prefix("urn:mpeg:14496-30:subs:").and_then(|v|v.parse::<usize>().ok()){let bytes=side_images.get(index.saturating_sub(1)).cloned().ok_or("Unsupported IMSC image resource: missing MP4 subsample")?;("image/png".into(),bytes)}else if let Some(raw)=reference.strip_prefix("data:image/png;base64,"){("image/png".into(),base64::Engine::decode(&base64::engine::general_purpose::STANDARD,raw).map_err(|_|"Unsupported IMSC image resource: invalid data URI")?)}else{return Err("Unsupported IMSC image resource: external URI".into())};cues.push(ParsedCue::Bitmap(BitmapCue{start:begin,end,viewport:bitmap_viewport(region.as_ref(),root_extent,cell),opacity:style.opacity.clone(),region,mime_type:resource.0,encoded_image:resource.1}));continue}
        let mut spans=Vec::new();collect_spans(node,&style,&styles,&mut spans);let known=["id","begin","end","dur","style","region","backgroundImage","image"];let unsupported=node.attrs.keys().filter(|k|!known.contains(&k.as_str())).cloned().collect();cues.push(ParsedCue::Text(TextCue{start:begin,end,region,style,spans,unsupported}));
    }Ok(cues)
}

pub(crate) fn bitmap_payload(cue:&BitmapCue)->Result<Vec<u8>,String>{if cue.mime_type!="image/png"{return Err(format!("Unsupported IMSC image type: {}",cue.mime_type))}let opacity=cue.opacity.as_deref().and_then(|v|v.parse::<f64>().ok()).unwrap_or(1.0).clamp(0.0,1.0);let mut out=b"YNOIMSC1".to_vec();for v in [cue.viewport.x,cue.viewport.y,cue.viewport.width,cue.viewport.height]{out.extend(v.to_le_bytes())}out.extend(((opacity*65535.0).round()as u16).to_le_bytes());out.extend(0u16.to_le_bytes());out.extend_from_slice(&cue.encoded_image);Ok(out)}

fn ass_color(value:&str)->Option<String>{let v=value.strip_prefix('#')?;if v.len()!=6&&v.len()!=8{return None}let(r,g,b)=(&v[0..2],&v[2..4],&v[4..6]);Some(format!("&H{}{}{}&",b,g,r))}
fn percent_pair(value:&str)->Option<(f64,f64)>{let p=value.split_whitespace().collect::<Vec<_>>();if p.len()!=2{return None}Some((p[0].strip_suffix('%')?.parse().ok()?,p[1].strip_suffix('%')?.parse().ok()?))}
pub(crate) fn ass_payload(cue:&TextCue)->String{let mut text=String::new();if let Some(r)=&cue.region{if let Some((x,y))=r.origin.as_deref().and_then(percent_pair){text.push_str(&format!("{{\\an7\\pos({x:.3},{y:.3})}}"))}}for span in &cue.spans{let mut tags=String::new();if span.style.font_weight.as_deref()==Some("bold"){tags.push_str("\\b1")}if span.style.font_style.as_deref()==Some("italic"){tags.push_str("\\i1")}if span.style.text_decoration.as_deref().is_some_and(|v|v.contains("underline")){tags.push_str("\\u1")}if let Some(c)=span.style.color.as_deref().and_then(ass_color){tags.push_str(&format!("\\1c{c}"))}if !tags.is_empty(){text.push('{');text.push_str(&tags);text.push('}')}text.push_str(&span.text.replace('\\',r"\").replace('{',r"\{").replace('}',r"\}").replace('\n',r"\N"));if !tags.is_empty(){text.push_str("{\\r}")}}format!("0,0,Default,,0,0,0,,{text}")}

pub(crate) const ASS_HEADER:&str="[Script Info]\nScriptType: v4.00+\nPlayResX: 100\nPlayResY: 100\nScaledBorderAndShadow: yes\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,sans-serif,5,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,3,0,0,2,0,0,0,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n";

#[cfg(test)]mod tests{use super::*;
 #[test]fn timing_forms_are_exact(){let t=Timing{frame_rate:25,sub_frame_rate:10,tick_rate:100};assert_eq!(parse_time_expression("01:02:03.500",t).unwrap(),ExactTime::new(7447,2).unwrap());assert_eq!(parse_time_expression("00:00:01:12.5",t).unwrap(),ExactTime::new(3,2).unwrap());assert_eq!(parse_time_expression("1500ms",t).unwrap(),ExactTime::new(3,2).unwrap());assert_eq!(parse_time_expression("50f",t).unwrap(),ExactTime::new(2,1).unwrap());assert_eq!(parse_time_expression("125t",t).unwrap(),ExactTime::new(5,4).unwrap())}
 #[test]fn styled_region_and_spans_normalize(){let xml=br##"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tts="http://www.w3.org/ns/ttml#styling"><head><styling><style xml:id="base" tts:color="#ff0000" tts:textAlign="center"/><style xml:id="em" style="base" tts:fontStyle="italic"/></styling><layout><region xml:id="bottom" tts:origin="15% 80%" tts:extent="70% 20%" tts:displayAlign="after"/></layout></head><body><div region="bottom"><p begin="1s" dur="2s" style="base">Hello <span style="em">world</span><br/>again</p></div></body></tt>"##;let cues=parse_document(xml).unwrap();let ParsedCue::Text(c)=&cues[0]else{panic!()};assert_eq!(c.start,ExactTime::new(1,1).unwrap());assert_eq!(c.end,ExactTime::new(3,1).unwrap());assert_eq!(c.region.as_ref().unwrap().origin.as_deref(),Some("15% 80%"));assert!(c.spans.iter().any(|s|s.style.font_style.as_deref()==Some("italic")));let ass=ass_payload(c);assert!(ass.contains("\\pos(15.000,80.000)"));assert!(ass.contains("\\i1"));assert!(ass.contains("\\N"))}
 #[test]fn embedded_imsc_image_is_not_treated_as_text(){let xml=br##"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:smpte="urn:smpte:tt:2010"><head><metadata><smpte:image xml:id="i" imagetype="image/png">iVBORw0KGgo=</smpte:image></metadata></head><body><div><p begin="0s" end="1s" smpte:backgroundImage="#i"/></div></body></tt>"##;let cues=parse_document(xml).unwrap();assert!(matches!(&cues[0],ParsedCue::Bitmap(b) if b.mime_type=="image/png"&&b.encoded_image.starts_with(b"\x89PNG")))}
 #[test]fn mp4_subsample_image_div_and_pixel_region_match_imsc(){let xml=br#"<tt xmlns="http://www.w3.org/ns/ttml" xmlns:smpte="urn:smpte" xmlns:tts="urn:tts" tts:extent="640px 360px"><head><layout><region xml:id="r" tts:origin="230px 298px" tts:extent="180px 32px"/></layout></head><body><div region="r" begin="1s" end="2s" smpte:backgroundImage="urn:mpeg:14496-30:subs:1"/></body></tt>"#;let mut sample=xml.to_vec();sample.extend(b"\x89PNG\r\n\x1a\n\0\0\0\0IEND\0\0\0\0");let cues=parse_document(&sample).unwrap();let ParsedCue::Bitmap(cue)=&cues[0]else{panic!()};assert_eq!(cue.viewport,BitmapViewport{x:359375,y:827778,width:281250,height:88889});assert!(bitmap_payload(cue).unwrap().starts_with(b"YNOIMSC1"))}
 #[test]fn timing_is_resolved_through_ancestors(){let xml=br#"<tt xmlns="http://www.w3.org/ns/ttml"><body begin="10s"><div begin="2s" end="8s"><p begin="1s" dur="2s">nested</p></div></body></tt>"#;let cues=parse_document(xml).unwrap();let ParsedCue::Text(c)=&cues[0]else{panic!()};assert_eq!(c.start,ExactTime::new(13,1).unwrap());assert_eq!(c.end,ExactTime::new(15,1).unwrap())}
}
