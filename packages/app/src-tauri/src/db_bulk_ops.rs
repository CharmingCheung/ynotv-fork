//! Optimized bulk database operations for sync operations
//!
//! This module provides high-performance bulk insert/update operations that
//! significantly reduce IPC overhead compared to individual row operations.

use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use log::info;

use crate::dvr::database::DvrDatabase;

/// Retry a database operation with exponential backoff when "database is locked" occurs.
/// This is a safety net in addition to PRAGMA busy_timeout.
fn with_db_retry<F, T>(mut operation: F) -> Result<T>
where
    F: FnMut() -> Result<T>,
{
    let max_retries = 5;
    let mut last_error = None;

    for attempt in 1..=max_retries {
        match operation() {
            Ok(result) => return Ok(result),
            Err(e) => {
                let err_str = e.to_string().to_lowercase();
                if err_str.contains("database is locked") || err_str.contains("busy") {
                    if attempt < max_retries {
                        let delay_ms = 100 * attempt as u64;
                        std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                    }
                    last_error = Some(e);
                } else {
                    return Err(e);
                }
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Max retries exceeded for database operation")))
}

/// A single channel to be inserted/updated
#[derive(Clone, Deserialize)]
pub struct BulkChannel {
    pub stream_id: String,
    pub source_id: String,
    pub category_ids: Option<String>, // JSON array as string
    pub name: String,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub channel_num: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub is_favorite: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub enabled: Option<i32>,
    #[serde(default)]
    pub stream_type: Option<String>,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub epg_channel_id: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(default)]
    pub custom_sid: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub tv_archive: Option<i32>,
    #[serde(default)]
    pub direct_source: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub xmltv_id: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub series_no: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub live: Option<i32>,
    #[serde(default)]
    pub provider_order: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub is_adult: Option<i32>,
    #[serde(default)]
    pub tv_archive_duration: Option<i32>,
    #[serde(default)]
    pub xtream_stream_id: Option<String>,
    #[serde(default)]
    pub catchup_type: Option<String>,
    #[serde(default)]
    pub catchup_source: Option<String>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub catchup_days: Option<i32>,
    #[serde(default)]
    pub kodi_props: Option<String>,
}

/// A single category to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkCategory {
    pub category_id: String,
    pub source_id: String,
    pub category_name: String,
    #[serde(default)]
    pub parent_id: Option<i32>,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub enabled: Option<i32>,
    #[serde(default)]
    pub display_order: Option<i32>,
    #[serde(default)]
    pub channel_count: Option<i32>,
    #[serde(default)]
    pub filter_words: Option<String>, // JSON array as string
    #[serde(default)]
    pub folder_id: Option<String>,
}

/// A single VOD Category to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkVodCategory {
    pub category_id: String,
    pub source_id: String,
    pub name: String,
    pub type_str: String,
    #[serde(default, deserialize_with = "deserialize_bool_to_i32")]
    pub enabled: Option<i32>,
    #[serde(default)]
    pub display_order: Option<i32>,
}

/// Custom deserializer that accepts both booleans and integers
/// Converts boolean true/false to 1/0 for SQLite storage
fn deserialize_bool_to_i32<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let value = serde_json::Value::deserialize(deserializer)?;

    match value {
        serde_json::Value::Bool(b) => Ok(Some(if b { 1 } else { 0 })),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Some(i as i32))
            } else {
                Err(D::Error::custom("expected integer"))
            }
        }
        serde_json::Value::Null => Ok(None),
        _ => Err(D::Error::custom("expected boolean or integer")),
    }
}

/// Custom deserializer that accepts numbers (integers or floats) and converts them to strings
fn deserialize_number_to_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de::Error;

    let value = serde_json::Value::deserialize(deserializer)?;

    match value {
        serde_json::Value::Number(n) => Ok(Some(n.to_string())),
        serde_json::Value::String(s) => Ok(Some(s)),
        serde_json::Value::Null => Ok(None),
        _ => Err(D::Error::custom("expected number or string")),
    }
}

/// A single EPG program to be inserted
#[derive(Debug, Clone, Deserialize)]
pub struct BulkProgram {
    pub id: String,
    pub stream_id: String,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    pub start: String, // ISO 8601 datetime string
    pub end: String,   // ISO 8601 datetime string
    pub source_id: String,
}

/// A single VOD movie to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkMovie {
    pub stream_id: String,
    pub source_id: String,
    #[serde(default)]
    pub category_ids: Option<String>, // JSON array as string
    pub name: String,
    #[serde(default)]
    pub tmdb_id: Option<i64>,
    #[serde(default)]
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(default)]
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub popularity: Option<f64>,
    #[serde(default)]
    pub match_attempted: Option<String>,
    #[serde(default)]
    pub container_extension: Option<String>,
    #[serde(default, deserialize_with = "deserialize_number_to_string")]
    pub rating: Option<String>,
    #[serde(default)]
    pub director: Option<String>,
    #[serde(default, deserialize_with = "deserialize_number_to_string")]
    pub year: Option<String>,
    #[serde(default)]
    pub cast: Option<String>,
    #[serde(default)]
    pub plot: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub duration_secs: Option<i64>,
    #[serde(default)]
    pub duration: Option<String>,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>,
    #[serde(default)]
    pub title: Option<String>, // Clean title without year
}

/// A single VOD series to be inserted/updated
#[derive(Debug, Clone, Deserialize)]
pub struct BulkSeries {
    pub series_id: String,
    pub source_id: String,
    #[serde(default)]
    pub category_ids: Option<String>, // JSON array as string
    pub name: String,
    #[serde(default)]
    pub tmdb_id: Option<i64>,
    #[serde(default)]
    pub imdb_id: Option<String>,
    #[serde(default)]
    pub added: Option<String>,
    #[serde(default)]
    pub backdrop_path: Option<String>,
    #[serde(default)]
    pub popularity: Option<f64>,
    #[serde(default)]
    pub match_attempted: Option<String>,
    #[serde(default)]
    pub _stalker_category: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub plot: Option<String>,
    #[serde(default)]
    pub cast: Option<String>,
    #[serde(default)]
    pub director: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    #[serde(default)]
    pub release_date: Option<String>, // Maps to releaseDate
    #[serde(default)]
    pub rating: Option<String>,
    #[serde(default)]
    pub youtube_trailer: Option<String>,
    #[serde(default)]
    pub episode_run_time: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub last_modified: Option<String>,
    #[serde(default, deserialize_with = "deserialize_number_to_string")]
    pub year: Option<String>,
    #[serde(default)]
    pub stream_type: Option<String>,
    #[serde(default)]
    pub stream_icon: Option<String>,
    #[serde(default)]
    pub direct_url: Option<String>,
    #[serde(default)]
    pub rating_5based: Option<f64>,
    #[serde(default)]
    pub category_id: Option<String>,
    #[serde(default)]
    pub _stalker_raw_id: Option<String>,
}

/// Result of a bulk operation
#[derive(Debug, Serialize)]
pub struct BulkResult {
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
    pub duration_ms: u64,
}

/// Bulk insert or replace channels (upsert operation)
/// Uses a single prepared statement in a transaction for maximum performance
pub fn bulk_upsert_channels(db: &DvrDatabase, channels: Vec<BulkChannel>) -> Result<BulkResult> {
    with_db_retry(|| bulk_upsert_channels_inner(db, channels.clone()))
}

fn bulk_upsert_channels_inner(db: &DvrDatabase, channels: Vec<BulkChannel>) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // Prepare the upsert statement once
    let mut stmt = tx.prepare(
        "INSERT INTO channels (
            stream_id, source_id, category_ids, name, channel_num, is_favorite,
            enabled, stream_type, stream_icon, epg_channel_id, added, custom_sid,
            tv_archive, direct_source, direct_url, xmltv_id, series_no, live, provider_order, is_adult,
            xtream_stream_id, tv_archive_duration, catchup_type, catchup_source, catchup_days, kodi_props
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)
        ON CONFLICT(stream_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_ids = excluded.category_ids,
            name = excluded.name,
            channel_num = excluded.channel_num,
            is_favorite = COALESCE(excluded.is_favorite, channels.is_favorite),
            enabled = COALESCE(excluded.enabled, channels.enabled),
            stream_type = excluded.stream_type,
            stream_icon = excluded.stream_icon,
            epg_channel_id = excluded.epg_channel_id,
            added = excluded.added,
            custom_sid = excluded.custom_sid,
            tv_archive = excluded.tv_archive,
            direct_source = excluded.direct_source,
            direct_url = excluded.direct_url,
            xmltv_id = excluded.xmltv_id,
            series_no = excluded.series_no,
            live = excluded.live,
            provider_order = excluded.provider_order,
            is_adult = excluded.is_adult,
            xtream_stream_id = excluded.xtream_stream_id,
            tv_archive_duration = excluded.tv_archive_duration,
            catchup_type = excluded.catchup_type,
            catchup_source = excluded.catchup_source,
            catchup_days = excluded.catchup_days,
            kodi_props = excluded.kodi_props",
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for channel in &channels {
        match stmt.execute(params![
            channel.stream_id,
            channel.source_id,
            channel.category_ids,
            channel.name,
            channel.channel_num,
            channel.is_favorite,
            channel.enabled,
            channel.stream_type,
            channel.stream_icon,
            channel.epg_channel_id,
            channel.added,
            channel.custom_sid,
            channel.tv_archive,
            channel.direct_source,
            channel.direct_url,
            channel.xmltv_id,
            channel.series_no,
            channel.live,
            channel.provider_order,
            channel.is_adult,
            channel.xtream_stream_id,
            channel.tv_archive_duration,
            channel.catchup_type,
            channel.catchup_source,
            channel.catchup_days,
            channel.kodi_props,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;

    // Rebuild the channel_categories membership map for every affected source,
    // derived from the (now current) channels table so it can never drift from
    // category_ids. Atomic with the upsert; a full source sync is one indexed
    // json_each scan per source.
    let mut sources: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for ch in &channels {
        if !ch.source_id.is_empty() {
            sources.insert(ch.source_id.as_str());
        }
    }
    for src in &sources {
        tx.execute(
            "DELETE FROM channel_categories WHERE source_id = ?1",
            params![src],
        )?;
        tx.execute(
            "INSERT OR IGNORE INTO channel_categories (stream_id, source_id, category_id)
             SELECT stream_id, source_id, value
             FROM channels, json_each(channels.category_ids)
             WHERE source_id = ?1",
            params![src],
        )?;
    }

    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert channels: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Bulk insert or replace categories (upsert operation)
pub fn bulk_upsert_categories(
    db: &DvrDatabase,
    categories: Vec<BulkCategory>,
) -> Result<BulkResult> {
    with_db_retry(|| bulk_upsert_categories_inner(db, categories.clone()))
}

fn bulk_upsert_categories_inner(
    db: &DvrDatabase,
    categories: Vec<BulkCategory>,
) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut stmt = tx.prepare(
        "INSERT INTO categories (
            category_id, source_id, category_name, parent_id, enabled,
            display_order, channel_count, filter_words, folder_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(category_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_name = excluded.category_name,
            parent_id = excluded.parent_id,
            enabled = COALESCE(categories.enabled, excluded.enabled),
            display_order = COALESCE(categories.display_order, excluded.display_order),
            channel_count = excluded.channel_count,
            filter_words = COALESCE(categories.filter_words, excluded.filter_words),
            folder_id = COALESCE(categories.folder_id, excluded.folder_id)",
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for category in categories {
        match stmt.execute(params![
            category.category_id,
            category.source_id,
            category.category_name,
            category.parent_id,
            category.enabled,
            category.display_order,
            category.channel_count,
            category.filter_words,
            category.folder_id,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert categories: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Bulk insert or replace VOD categories (upsert operation)
pub fn bulk_upsert_vod_categories(
    db: &DvrDatabase,
    categories: Vec<BulkVodCategory>,
) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut stmt = tx.prepare(
        "INSERT INTO vodCategories (
            category_id, source_id, name, type, enabled, display_order
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(category_id) DO UPDATE SET
            source_id = excluded.source_id,
            name = excluded.name,
            type = excluded.type,
            enabled = COALESCE(vodCategories.enabled, excluded.enabled),
            display_order = COALESCE(vodCategories.display_order, excluded.display_order)",
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for category in categories {
        match stmt.execute(params![
            category.category_id,
            category.source_id,
            category.name,
            category.type_str,
            category.enabled,
            category.display_order,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert VOD categories: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Bulk insert EPG programs with transaction
/// First clears existing programs for the source, then inserts new ones
pub fn bulk_replace_programs(
    db: &DvrDatabase,
    source_id: &str,
    programs: Vec<BulkProgram>,
) -> Result<BulkResult> {
    with_db_retry(|| bulk_replace_programs_inner(db, source_id, programs.clone()))
}

fn bulk_replace_programs_inner(
    db: &DvrDatabase,
    source_id: &str,
    programs: Vec<BulkProgram>,
) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // Delete existing programs for this source
    let deleted = tx.execute(
        "DELETE FROM programs WHERE source_id = ?1",
        params![source_id],
    )?;

    // Insert new programs (use OR IGNORE to skip duplicates)
    let mut stmt = tx.prepare(
        "INSERT OR IGNORE INTO programs (
            id, stream_id, title, subtitle, description, start, end, source_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )?;

    let mut inserted = 0;
    let mut duplicates = 0;

    for program in programs {
        match stmt.execute(params![
            program.id,
            program.stream_id,
            program.title,
            program.subtitle,
            program.description,
            program.start,
            program.end,
            program.source_id,
        ]) {
            Ok(1) => inserted += 1,
            Ok(_) => duplicates += 1, // Row was ignored (duplicate)
            Err(e) => return Err(e.into()),
        }
    }

    if duplicates > 0 {
        info!("Skipped {} duplicate EPG programs", duplicates);
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk replace programs for {}: {} deleted, {} inserted in {}ms",
        source_id, deleted, inserted, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated: 0,
        deleted: deleted as usize,
        duration_ms,
    })
}

/// Bulk upsert VOD movies
pub fn bulk_upsert_movies(db: &DvrDatabase, movies: Vec<BulkMovie>) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut stmt = tx.prepare(
        "INSERT INTO vodMovies (
            stream_id, source_id, category_ids, name, tmdb_id, imdb_id, added,
            backdrop_path, popularity, match_attempted, container_extension,
            rating, director, year, cast, plot, genre, duration_secs, duration,
            stream_icon, direct_url, release_date, title
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
        ON CONFLICT(stream_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_ids = excluded.category_ids,
            name = excluded.name,
            tmdb_id = COALESCE(excluded.tmdb_id, vodMovies.tmdb_id),
            imdb_id = COALESCE(excluded.imdb_id, vodMovies.imdb_id),
            added = excluded.added,
            backdrop_path = COALESCE(excluded.backdrop_path, vodMovies.backdrop_path),
            popularity = COALESCE(excluded.popularity, vodMovies.popularity),
            match_attempted = COALESCE(excluded.match_attempted, vodMovies.match_attempted),
            container_extension = excluded.container_extension,
            rating = excluded.rating,
            director = excluded.director,
            year = excluded.year,
            cast = excluded.cast,
            plot = excluded.plot,
            genre = excluded.genre,
            duration_secs = excluded.duration_secs,
            duration = excluded.duration,
            stream_icon = excluded.stream_icon,
            direct_url = excluded.direct_url,
            release_date = excluded.release_date,
            title = excluded.title"
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for movie in movies {
        match stmt.execute(params![
            movie.stream_id,
            movie.source_id,
            movie.category_ids,
            movie.name,
            movie.tmdb_id,
            movie.imdb_id,
            movie.added,
            movie.backdrop_path,
            movie.popularity,
            movie.match_attempted,
            movie.container_extension,
            movie.rating,
            movie.director,
            movie.year,
            movie.cast,
            movie.plot,
            movie.genre,
            movie.duration_secs,
            movie.duration,
            movie.stream_icon,
            movie.direct_url,
            movie.release_date,
            movie.title,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert movies: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Bulk upsert VOD series
pub fn bulk_upsert_series(db: &DvrDatabase, series: Vec<BulkSeries>) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut stmt = tx.prepare(
        "INSERT INTO vodSeries (
            series_id, source_id, category_ids, name, tmdb_id, imdb_id, added,
            backdrop_path, popularity, match_attempted, _stalker_category, cover,
            plot, cast, director, genre, releaseDate, rating, youtube_trailer,
            episode_run_time, title, last_modified, year, stream_type,
            stream_icon, direct_url, rating_5based, category_id, _stalker_raw_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29)
        ON CONFLICT(series_id) DO UPDATE SET
            source_id = excluded.source_id,
            category_ids = excluded.category_ids,
            name = excluded.name,
            tmdb_id = COALESCE(excluded.tmdb_id, vodSeries.tmdb_id),
            imdb_id = COALESCE(excluded.imdb_id, vodSeries.imdb_id),
            added = excluded.added,
            backdrop_path = COALESCE(excluded.backdrop_path, vodSeries.backdrop_path),
            popularity = COALESCE(excluded.popularity, vodSeries.popularity),
            match_attempted = COALESCE(excluded.match_attempted, vodSeries.match_attempted),
            _stalker_category = excluded._stalker_category,
            cover = excluded.cover,
            plot = excluded.plot,
            cast = excluded.cast,
            director = excluded.director,
            genre = excluded.genre,
            releaseDate = excluded.releaseDate,
            rating = excluded.rating,
            youtube_trailer = excluded.youtube_trailer,
            episode_run_time = excluded.episode_run_time,
            title = excluded.title,
            last_modified = excluded.last_modified,
            year = excluded.year,
            stream_type = excluded.stream_type,
            stream_icon = excluded.stream_icon,
            direct_url = excluded.direct_url,
            rating_5based = excluded.rating_5based,
            category_id = excluded.category_id,
            _stalker_raw_id = excluded._stalker_raw_id"
    )?;

    let mut inserted = 0;
    let mut updated = 0;

    for s in series {
        match stmt.execute(params![
            s.series_id,
            s.source_id,
            s.category_ids,
            s.name,
            s.tmdb_id,
            s.imdb_id,
            s.added,
            s.backdrop_path,
            s.popularity,
            s.match_attempted,
            s._stalker_category,
            s.cover,
            s.plot,
            s.cast,
            s.director,
            s.genre,
            s.release_date,
            s.rating,
            s.youtube_trailer,
            s.episode_run_time,
            s.title,
            s.last_modified,
            s.year,
            s.stream_type,
            s.stream_icon,
            s.direct_url,
            s.rating_5based,
            s.category_id,
            s._stalker_raw_id,
        ])? {
            1 => inserted += 1,
            _ => updated += 1,
        }
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;

    info!(
        "Bulk upsert series: {} inserted, {} updated in {}ms",
        inserted, updated, duration_ms
    );

    Ok(BulkResult {
        inserted,
        updated,
        deleted: 0,
        duration_ms,
    })
}

/// Delete channels by stream_id
pub fn bulk_delete_channels(db: &DvrDatabase, stream_ids: Vec<String>) -> Result<usize> {
    let mut conn = db.get_conn()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let placeholders: Vec<String> = stream_ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "DELETE FROM channels WHERE stream_id IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = tx.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = stream_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();

    let deleted = stmt.execute(rusqlite::params_from_iter(params.iter()))?;
    stmt.finalize()?;

    // Keep the channel_categories membership map in sync with the deleted rows
    // (no FK cascades are enabled, so this must be explicit).
    let map_sql = format!(
        "DELETE FROM channel_categories WHERE stream_id IN ({})",
        placeholders.join(", ")
    );
    let mut map_stmt = tx.prepare(&map_sql)?;
    map_stmt.execute(rusqlite::params_from_iter(params.iter()))?;
    map_stmt.finalize()?;

    tx.commit()?;

    info!("Bulk deleted {} channels", deleted);

    Ok(deleted as usize)
}

/// Delete categories by category_id
pub fn bulk_delete_categories(db: &DvrDatabase, category_ids: Vec<String>) -> Result<usize> {
    let mut conn = db.get_conn()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let placeholders: Vec<String> = category_ids.iter().map(|_| "?".to_string()).collect();
    let sql = format!(
        "DELETE FROM categories WHERE category_id IN ({})",
        placeholders.join(", ")
    );

    let mut stmt = tx.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = category_ids
        .iter()
        .map(|id| id as &dyn rusqlite::ToSql)
        .collect();

    let deleted = stmt.execute(rusqlite::params_from_iter(params.iter()))?;
    stmt.finalize()?;
    tx.commit()?;

    info!("Bulk deleted {} categories", deleted);

    Ok(deleted as usize)
}

/// Update sourcesMeta
#[derive(Debug, Clone, Deserialize)]
pub struct SourceMetaUpdate {
    pub source_id: String,
    #[serde(default)]
    pub epg_url: Option<String>,
    #[serde(default)]
    pub last_synced: Option<String>,
    #[serde(default)]
    pub vod_last_synced: Option<String>,
    #[serde(default)]
    pub channel_count: Option<i32>,
    #[serde(default)]
    pub category_count: Option<i32>,
    #[serde(default)]
    pub vod_movie_count: Option<i32>,
    #[serde(default)]
    pub vod_series_count: Option<i32>,
    #[serde(default)]
    pub expiry_date: Option<String>,
    #[serde(default)]
    pub active_cons: Option<String>,
    #[serde(default)]
    pub max_connections: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub epg_timeshift_hours: Option<f64>,
}

pub fn update_source_meta(db: &DvrDatabase, meta: SourceMetaUpdate) -> Result<()> {
    with_db_retry(|| update_source_meta_inner(db, meta.clone()))
}

fn update_source_meta_inner(db: &DvrDatabase, meta: SourceMetaUpdate) -> Result<()> {
    let mut conn = db.get_conn()?;
    // IMMEDIATE: acquire the write lock at BEGIN instead of lazily at the
    // first UPDATE. In WAL mode a deferred read-transaction that upgrades to a
    // write gets SQLITE_BUSY_SNAPSHOT (stale snapshot) the moment another
    // connection commits — busy_timeout can't fix that, and concurrent EPG
    // inserts trigger it constantly. IMMEDIATE queues on the lock
    // (busy_timeout waits) and never hits the stale-snapshot error.
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // Try to update first - using COALESCE to preserve existing values when new values are NULL
    // This approach works for both partial updates and new records
    let rows_affected = tx.execute(
        "UPDATE sourcesMeta SET
            epg_url = COALESCE(?1, epg_url),
            last_synced = COALESCE(?2, last_synced),
            vod_last_synced = COALESCE(?3, vod_last_synced),
            channel_count = COALESCE(?4, channel_count),
            category_count = COALESCE(?5, category_count),
            vod_movie_count = COALESCE(?6, vod_movie_count),
            vod_series_count = COALESCE(?7, vod_series_count),
            expiry_date = COALESCE(?8, expiry_date),
            active_cons = COALESCE(?9, active_cons),
            max_connections = COALESCE(?10, max_connections),
            error = COALESCE(?11, error),
            epg_timeshift_hours = COALESCE(?12, epg_timeshift_hours)
        WHERE source_id = ?13",
        params![
            meta.epg_url,
            meta.last_synced,
            meta.vod_last_synced,
            meta.channel_count,
            meta.category_count,
            meta.vod_movie_count,
            meta.vod_series_count,
            meta.expiry_date,
            meta.active_cons,
            meta.max_connections,
            meta.error,
            meta.epg_timeshift_hours,
            meta.source_id,
        ],
    )?;

    // If no rows were updated, insert a new record
    if rows_affected == 0 {
        tx.execute(
            "INSERT INTO sourcesMeta (
                source_id, epg_url, last_synced, vod_last_synced, channel_count,
                category_count, vod_movie_count, vod_series_count, expiry_date,
                active_cons, max_connections, error, epg_timeshift_hours
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                meta.source_id,
                meta.epg_url,
                meta.last_synced,
                meta.vod_last_synced,
                meta.channel_count,
                meta.category_count,
                meta.vod_movie_count,
                meta.vod_series_count,
                meta.expiry_date,
                meta.active_cons,
                meta.max_connections,
                meta.error,
                meta.epg_timeshift_hours,
            ],
        )?;
    }

    tx.commit()?;
    Ok(())
}

// ============================================================================
// Channel Metadata Bulk Upsert
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BulkChannelMetadata {
    pub stream_id: String,
    pub source_id: String,
    pub resolution_width: Option<i64>,
    pub resolution_height: Option<i64>,
    pub fps: Option<f64>,
    pub audio_channels: Option<String>,
    pub quality_label: Option<String>,
    #[serde(default)]
    pub video_bitrate_kbps: Option<i64>,
    #[serde(default)]
    pub audio_bitrate_kbps: Option<i64>,
    #[serde(default)]
    pub bitrate_kbps: Option<i64>,
    pub last_updated: Option<String>,
}

pub fn bulk_upsert_channel_metadata(
    db: &DvrDatabase,
    items: Vec<BulkChannelMetadata>,
) -> Result<BulkResult> {
    with_db_retry(|| bulk_upsert_channel_metadata_inner(db, items.clone()))
}

fn bulk_upsert_channel_metadata_inner(
    db: &DvrDatabase,
    items: Vec<BulkChannelMetadata>,
) -> Result<BulkResult> {
    let start = std::time::Instant::now();
    let mut conn = db.get_conn()?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    let mut stmt = tx.prepare(
        "INSERT INTO channelMetadata (
            stream_id, source_id, resolution_width, resolution_height, fps, audio_channels, quality_label,
            video_bitrate_kbps, audio_bitrate_kbps, bitrate_kbps, last_updated
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
        ON CONFLICT(stream_id) DO UPDATE SET
            source_id = excluded.source_id,
            resolution_width = COALESCE(excluded.resolution_width, channelMetadata.resolution_width),
            resolution_height = COALESCE(excluded.resolution_height, channelMetadata.resolution_height),
            fps = COALESCE(excluded.fps, channelMetadata.fps),
            audio_channels = COALESCE(excluded.audio_channels, channelMetadata.audio_channels),
            quality_label = COALESCE(excluded.quality_label, channelMetadata.quality_label),
            video_bitrate_kbps = COALESCE(excluded.video_bitrate_kbps, channelMetadata.video_bitrate_kbps),
            audio_bitrate_kbps = COALESCE(excluded.audio_bitrate_kbps, channelMetadata.audio_bitrate_kbps),
            bitrate_kbps = COALESCE(excluded.bitrate_kbps, channelMetadata.bitrate_kbps),
            last_updated = excluded.last_updated",
    )?;

    let now_str = chrono::Utc::now().to_rfc3339();
    let mut upserted = 0;

    for item in items {
        let updated_time = item.last_updated.unwrap_or_else(|| now_str.clone());
        stmt.execute(params![
            item.stream_id,
            item.source_id,
            item.resolution_width,
            item.resolution_height,
            item.fps,
            item.audio_channels,
            item.quality_label,
            item.video_bitrate_kbps,
            item.audio_bitrate_kbps,
            item.bitrate_kbps,
            updated_time,
        ])?;
        upserted += 1;
    }

    stmt.finalize()?;
    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;
    info!("[DB] Bulk upserted {} channelMetadata rows in {}ms", upserted, duration_ms);

    Ok(BulkResult {
        inserted: upserted,
        updated: 0,
        deleted: 0,
        duration_ms,
    })
}

// ─── Generic bulk insert (renderer SqliteAdapter) ────────────────────────────

/// Generic bulk insert/upsert request from the renderer's SqliteAdapter
/// (`invoke('bulk_insert', { request })`). Mirrors the JS plugin fallback's
/// semantics so `bulkPut`/`bulkAdd` stop doing per-batch JS SQL round-trips.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkInsertRequest {
    pub table: String,
    pub primary_key: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    /// "insert" (ignore conflicts, Dexie bulkAdd) or "replace" (upsert, Dexie bulkPut).
    pub operation: String,
}

/// Quote a SQLite identifier defensively. The renderer only ever sends
/// identifiers from its own schema (alphanumeric + underscore), so this is a
/// cheap safety net rather than a full parser.
fn quote_identifier(ident: &str) -> Result<String> {
    if ident.is_empty()
        || !ident
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(anyhow::anyhow!("Invalid SQL identifier: {:?}", ident));
    }
    Ok(format!("\"{}\"", ident.replace('"', "\"\"")))
}

/// Convert a JSON value to a rusqlite value, mirroring the JS adapter's own
/// conversions (booleans -> 0/1; objects/arrays -> JSON text).
fn json_to_sqlite(v: &serde_json::Value) -> rusqlite::types::Value {
    match v {
        serde_json::Value::Null => rusqlite::types::Value::Null,
        serde_json::Value::Bool(b) => {
            rusqlite::types::Value::Integer(if *b { 1 } else { 0 })
        }
        serde_json::Value::Number(n) => match n.as_i64() {
            Some(i) => rusqlite::types::Value::Integer(i),
            None => rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.0)),
        },
        serde_json::Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        serde_json::Value::Array(_) | serde_json::Value::Object(_) => {
            rusqlite::types::Value::Text(serde_json::to_string(v).unwrap_or_default())
        }
    }
}

/// Generic bulk insert/upsert for the renderer's SqliteAdapter. One
/// transaction per call; rows are chunked to stay under SQLite's variable
/// limit when a wide table ships many rows in one chunk.
pub fn bulk_insert_generic(
    db: &DvrDatabase,
    request: BulkInsertRequest,
) -> Result<BulkResult> {
    with_db_retry(|| {
        let mut conn = db.get_conn()?;
        bulk_insert_generic_conn(&mut conn, &request)
    })
}

fn bulk_insert_generic_conn(
    conn: &mut rusqlite::Connection,
    request: &BulkInsertRequest,
) -> Result<BulkResult> {
    let start = std::time::Instant::now();

    if request.columns.is_empty() {
        return Err(anyhow::anyhow!("bulk_insert: no columns provided"));
    }
    if request.rows.is_empty() {
        return Ok(BulkResult {
            inserted: 0,
            updated: 0,
            deleted: 0,
            duration_ms: 0,
        });
    }
    for (i, row) in request.rows.iter().enumerate() {
        if row.len() != request.columns.len() {
            return Err(anyhow::anyhow!(
                "bulk_insert: row {} has {} values, expected {}",
                i,
                row.len(),
                request.columns.len()
            ));
        }
    }

    let table = quote_identifier(&request.table)?;
    let pk = quote_identifier(&request.primary_key)?;
    let columns: Vec<String> = request
        .columns
        .iter()
        .map(|c| quote_identifier(c))
        .collect::<Result<_>>()?;
    let column_list = columns.join(", ");
    let placeholders = vec!["?"; columns.len()].join(", ");

    // Upsert must match the JS plugin fallback: REPLACE INTO deletes the old
    // row first, which fires ON DELETE CASCADE on foreign keys (e.g.
    // failover_group_members), so we use ON CONFLICT(pk) DO UPDATE for
    // non-PK columns and OR IGNORE for the degenerate all-PK case.
    let is_replace = request.operation.eq_ignore_ascii_case("replace");
    // Quoted non-PK columns, aligned with `columns` (both quote and filter on
    // the raw names so the ON CONFLICT ... DO UPDATE clause matches).
    let non_pk: Vec<&String> = columns
        .iter()
        .zip(request.columns.iter())
        .filter(|(_, raw)| *raw != &request.primary_key)
        .map(|(quoted, _)| quoted)
        .collect();

    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;

    // SQLITE_MAX_VARIABLE_NUMBER is 32766 on modern builds; the renderer sends
    // 2000-row chunks, and a wide table (channels has 25+ columns) would blow
    // past it in a single statement. Chunk inside the transaction instead.
    const MAX_VARS: usize = 30000;
    let max_rows_per_stmt = (MAX_VARS / columns.len()).max(1);

    let mut written = 0usize;
    let mut ignored = 0usize;

    for chunk_start in (0..request.rows.len()).step_by(max_rows_per_stmt) {
        let chunk_end = (chunk_start + max_rows_per_stmt).min(request.rows.len());
        let chunk = &request.rows[chunk_start..chunk_end];
        let row_placeholders = vec![format!("({})", placeholders); chunk.len()].join(", ");

        let sql = if is_replace {
            if non_pk.is_empty() {
                format!(
                    "INSERT OR IGNORE INTO {} ({}) VALUES {}",
                    table, column_list, row_placeholders
                )
            } else {
                let update_clause = non_pk
                    .iter()
                    .map(|c| format!("{} = excluded.{}", c, c))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!(
                    "INSERT INTO {} ({}) VALUES {} ON CONFLICT({}) DO UPDATE SET {}",
                    table, column_list, row_placeholders, pk, update_clause
                )
            }
        } else {
            format!(
                "INSERT OR IGNORE INTO {} ({}) VALUES {}",
                table, column_list, row_placeholders
            )
        };

        let mut stmt = tx.prepare(&sql)?;
        let mut param_idx = 1;
        for row in chunk {
            for v in row {
                stmt.raw_bind_parameter(param_idx, json_to_sqlite(v))?;
                param_idx += 1;
            }
        }
        let affected = stmt.raw_execute()?;
        written += affected;
        ignored += chunk.len() - affected;
        stmt.finalize()?;
    }

    tx.commit()?;

    let duration_ms = start.elapsed().as_millis() as u64;
    info!(
        "[DB] Bulk {} into {}: {} rows written, {} ignored in {}ms",
        if is_replace { "upsert" } else { "insert" },
        request.table,
        written,
        ignored,
        duration_ms
    );

    Ok(BulkResult {
        inserted: written,
        updated: ignored,
        deleted: 0,
        duration_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn program_request(operation: &str, rows: Vec<Vec<serde_json::Value>>) -> BulkInsertRequest {
        BulkInsertRequest {
            table: "programs".to_string(),
            primary_key: "id".to_string(),
            columns: vec!["id".to_string(), "stream_id".to_string(), "title".to_string()],
            rows,
            operation: operation.to_string(),
        }
    }

    #[test]
    fn replace_upserts_duplicate_primary_keys_in_place() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE programs (id TEXT PRIMARY KEY, stream_id TEXT, title TEXT)",
        )
        .unwrap();

        let req = program_request(
            "replace",
            vec![
                vec![json!("p1"), json!("s1"), json!("Alpha")],
                vec![json!("p2"), json!("s1"), json!("Beta")],
                // Same primary key as p1 -> must update, not duplicate.
                vec![json!("p1"), json!("s1"), json!("Alpha2")],
            ],
        );

        let res = bulk_insert_generic_conn(&mut conn, &req).unwrap();
        assert_eq!(res.inserted + res.updated, 3);

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM programs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 2);
        let title: String = conn
            .query_row("SELECT title FROM programs WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Alpha2");
    }

    #[test]
    fn insert_operation_ignores_duplicate_primary_keys() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE programs (id TEXT PRIMARY KEY, stream_id TEXT, title TEXT)",
        )
        .unwrap();

        let req = program_request(
            "insert",
            vec![
                vec![json!("p1"), json!("s1"), json!("Alpha")],
                vec![json!("p2"), json!("s1"), json!("Beta")],
                vec![json!("p1"), json!("s1"), json!("ShouldBeIgnored")],
            ],
        );

        let res = bulk_insert_generic_conn(&mut conn, &req).unwrap();
        assert_eq!(res.inserted, 2);
        assert_eq!(res.updated, 1); // the ignored duplicate

        let title: String = conn
            .query_row("SELECT title FROM programs WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(title, "Alpha"); // unchanged by the ignored dup
    }

    #[test]
    fn wide_chunks_stay_under_sqlite_variable_limit() {
        // One column, so each statement holds up to MAX_VARS rows; push past
        // the internal chunk boundary to prove the step_by chunking works.
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY)").unwrap();

        let rows: Vec<Vec<serde_json::Value>> = (0..30005)
            .map(|i| vec![json!(format!("id_{}", i))])
            .collect();
        let req = BulkInsertRequest {
            table: "t".to_string(),
            primary_key: "id".to_string(),
            columns: vec!["id".to_string()],
            rows,
            operation: "replace".to_string(),
        };

        let res = bulk_insert_generic_conn(&mut conn, &req).unwrap();
        assert_eq!(res.inserted, 30005);
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 30005);
    }

    #[test]
    fn rejects_misaligned_rows_and_bad_identifiers() {
        let mut conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)").unwrap();

        // Row with the wrong number of values.
        let bad = program_request(
            "replace",
            vec![vec![json!("p1"), json!("s1")]], // missing title
        );
        assert!(bulk_insert_generic_conn(&mut conn, &bad).is_err());

        // Identifiers with anything but [A-Za-z0-9_] are rejected.
        let injection = BulkInsertRequest {
            table: "programs; DROP TABLE programs --".to_string(),
            primary_key: "id".to_string(),
            columns: vec!["id".to_string()],
            rows: vec![vec![json!("x")]],
            operation: "replace".to_string(),
        };
        assert!(bulk_insert_generic_conn(&mut conn, &injection).is_err());

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0); // nothing was written by the rejected requests
    }
}
