//! Exact time and compact `SegmentTimeline` experiment.
//!
//! This module deliberately has no Tauri, mpv, FFmpeg, network, or playback
//! dependencies.  Segment positions are DASH segment numbers: they begin at
//! `start_number` and are never renumbered by eviction.

// The experiment is intentionally disconnected from production call sites.
#![allow(dead_code)]

use std::cmp::Ordering;
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Rounding {
    Floor,
    Ceil,
    TowardZero,
    AwayFromZero,
    NearestTiesAway,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ExactTime {
    numerator: i128,
    denominator: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TimeError {
    ZeroTimescale,
    Overflow,
}

impl fmt::Display for TimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroTimescale => f.write_str("time scale must be non-zero"),
            Self::Overflow => f.write_str("exact time arithmetic overflowed i128"),
        }
    }
}

impl ExactTime {
    pub(crate) const ZERO: Self = Self {
        numerator: 0,
        denominator: 1,
    };

    pub(crate) fn new(ticks: i128, timescale: u64) -> Result<Self, TimeError> {
        if timescale == 0 {
            return Err(TimeError::ZeroTimescale);
        }
        if ticks == 0 {
            return Ok(Self::ZERO);
        }
        let divisor = gcd_u128(ticks.unsigned_abs(), u128::from(timescale));
        Ok(Self {
            numerator: ticks / divisor as i128,
            denominator: timescale / divisor as u64,
        })
    }

    pub(crate) fn numerator(self) -> i128 {
        self.numerator
    }

    pub(crate) fn denominator(self) -> u64 {
        self.denominator
    }

    pub(crate) fn checked_add(self, other: Self) -> Result<Self, TimeError> {
        let shared = gcd_u128(u128::from(self.denominator), u128::from(other.denominator)) as u64;
        let left_factor = other.denominator / shared;
        let right_factor = self.denominator / shared;
        let numerator = self
            .numerator
            .checked_mul(i128::from(left_factor))
            .and_then(|left| {
                other
                    .numerator
                    .checked_mul(i128::from(right_factor))
                    .and_then(|right| left.checked_add(right))
            })
            .ok_or(TimeError::Overflow)?;
        let denominator = self
            .denominator
            .checked_mul(left_factor)
            .ok_or(TimeError::Overflow)?;
        Self::new(numerator, denominator)
    }

    pub(crate) fn checked_sub(self, other: Self) -> Result<Self, TimeError> {
        let negated = other.numerator.checked_neg().ok_or(TimeError::Overflow)?;
        self.checked_add(Self {
            numerator: negated,
            denominator: other.denominator,
        })
    }

    /// Converts this exact value to integral ticks in `target_timescale`.
    ///
    /// `Floor` and `Ceil` are mathematical -infinity/+infinity operations;
    /// `TowardZero` truncates; `AwayFromZero` increases magnitude; and
    /// `NearestTiesAway` sends exact half ticks away from zero.
    pub(crate) fn rescale(
        self,
        target_timescale: u64,
        rounding: Rounding,
    ) -> Result<i128, TimeError> {
        if target_timescale == 0 {
            return Err(TimeError::ZeroTimescale);
        }
        let scaled = self
            .numerator
            .checked_mul(i128::from(target_timescale))
            .ok_or(TimeError::Overflow)?;
        Ok(div_round(scaled, i128::from(self.denominator), rounding))
    }
}

impl Ord for ExactTime {
    fn cmp(&self, other: &Self) -> Ordering {
        // Euclidean quotients avoid cross-multiplying arbitrary i128 values.
        // Remainders are each < u64::MAX, so their cross-products fit u128.
        let left_den = i128::from(self.denominator);
        let right_den = i128::from(other.denominator);
        let left_whole = self.numerator.div_euclid(left_den);
        let right_whole = other.numerator.div_euclid(right_den);
        match left_whole.cmp(&right_whole) {
            Ordering::Equal => {
                let left_rem = self.numerator.rem_euclid(left_den) as u128;
                let right_rem = other.numerator.rem_euclid(right_den) as u128;
                (left_rem * u128::from(other.denominator))
                    .cmp(&(right_rem * u128::from(self.denominator)))
            }
            ordering => ordering,
        }
    }
}

impl PartialOrd for ExactTime {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn gcd_u128(mut left: u128, mut right: u128) -> u128 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

fn div_round(numerator: i128, denominator: i128, rounding: Rounding) -> i128 {
    debug_assert!(denominator > 0);
    let truncated = numerator / denominator;
    let remainder = numerator % denominator;
    if remainder == 0 {
        return truncated;
    }
    match rounding {
        Rounding::TowardZero => truncated,
        Rounding::Floor => truncated - i128::from(numerator < 0),
        Rounding::Ceil => truncated + i128::from(numerator > 0),
        Rounding::AwayFromZero => truncated + if numerator > 0 { 1 } else { -1 },
        Rounding::NearestTiesAway => {
            let twice_remainder = remainder.unsigned_abs() * 2;
            if twice_remainder >= denominator as u128 {
                truncated + if numerator > 0 { 1 } else { -1 }
            } else {
                truncated
            }
        }
    }
}

pub(crate) fn presentation_time(
    media_ticks: i128,
    timescale: u64,
    period_start: ExactTime,
    presentation_time_offset: i128,
) -> Result<ExactTime, TimeError> {
    let media = ExactTime::new(media_ticks, timescale)?;
    let offset = ExactTime::new(presentation_time_offset, timescale)?;
    media.checked_add(period_start)?.checked_sub(offset)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct TimelineEntry {
    pub(crate) t: Option<i128>,
    pub(crate) d: i128,
    pub(crate) r: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TimelineError {
    Time(TimeError),
    NonPositiveDuration { entry: usize },
    UnsupportedRepeat { entry: usize, repeat: i64 },
    UnboundedNegativeRepeat { entry: usize },
    NegativeRepeatNeedsNextStart { entry: usize },
    InvalidNegativeRepeatBoundary { entry: usize },
    NonMonotonicStart { entry: usize },
    Overflow,
}

impl From<TimeError> for TimelineError {
    fn from(value: TimeError) -> Self {
        Self::Time(value)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct TimelineRun {
    media_start: i128,
    duration: i128,
    count: u64,
    first_position: u64,
    source_entry: usize,
    last_end_override: Option<i128>,
}

impl TimelineRun {
    fn media_start_at(&self, offset: u64) -> Option<i128> {
        self.duration
            .checked_mul(i128::from(offset))
            .and_then(|delta| self.media_start.checked_add(delta))
    }

    fn media_end_at(&self, offset: u64) -> Option<i128> {
        if offset + 1 == self.count {
            if let Some(end) = self.last_end_override {
                return Some(end);
            }
        }
        self.media_start_at(offset)?.checked_add(self.duration)
    }

    fn last_position(&self) -> Option<u64> {
        self.first_position.checked_add(self.count.checked_sub(1)?)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SegmentRef {
    pub(crate) position: u64,
    pub(crate) media_time: i128,
    pub(crate) presentation_start: ExactTime,
    pub(crate) presentation_end: ExactTime,
    pub(crate) source_entry: usize,
}

#[derive(Clone, Debug)]
pub(crate) struct CompactTimeline {
    timescale: u64,
    presentation_time_offset: i128,
    period_start: ExactTime,
    period_end: Option<ExactTime>,
    runs: Vec<TimelineRun>,
}

impl CompactTimeline {
    pub(crate) fn new(
        entries: &[TimelineEntry],
        timescale: u64,
        presentation_time_offset: i128,
        start_number: u64,
        period_start: ExactTime,
        period_duration: Option<ExactTime>,
    ) -> Result<Self, TimelineError> {
        if timescale == 0 {
            return Err(TimeError::ZeroTimescale.into());
        }
        let period_end = period_duration
            .map(|duration| period_start.checked_add(duration))
            .transpose()?;
        let period_media_end = match period_duration {
            Some(duration) => Some(
                presentation_time_offset
                    .checked_add(duration.rescale(timescale, Rounding::Ceil)?)
                    .ok_or(TimelineError::Overflow)?,
            ),
            None => None,
        };

        let mut runs: Vec<TimelineRun> = Vec::with_capacity(entries.len());
        let mut cursor = 0_i128;
        let mut next_position = start_number;

        for (entry_index, entry) in entries.iter().enumerate() {
            if entry.d <= 0 {
                return Err(TimelineError::NonPositiveDuration { entry: entry_index });
            }
            if entry.r < -1 {
                return Err(TimelineError::UnsupportedRepeat {
                    entry: entry_index,
                    repeat: entry.r,
                });
            }
            let start = entry.t.unwrap_or(cursor);
            if let Some(previous) = runs.last_mut() {
                let previous_final_start = previous
                    .media_start_at(previous.count - 1)
                    .ok_or(TimelineError::Overflow)?;
                if start <= previous_final_start {
                    return Err(TimelineError::NonMonotonicStart { entry: entry_index });
                }
                let nominal_end = previous
                    .media_start
                    .checked_add(
                        previous
                            .duration
                            .checked_mul(i128::from(previous.count))
                            .ok_or(TimelineError::Overflow)?,
                    )
                    .ok_or(TimelineError::Overflow)?;
                if nominal_end != start {
                    // Matches Shaka's observable reference ranges: an explicit
                    // next t stretches a gap or clips an overlap on the prior ref.
                    previous.last_end_override = Some(start);
                }
            }

            let count = if entry.r >= 0 {
                u64::try_from(entry.r)
                    .ok()
                    .and_then(|repeat| repeat.checked_add(1))
                    .ok_or(TimelineError::Overflow)?
            } else if let Some(next_entry) = entries.get(entry_index + 1) {
                let next_start = next_entry
                    .t
                    .ok_or(TimelineError::NegativeRepeatNeedsNextStart { entry: entry_index })?;
                if next_start <= start {
                    return Err(TimelineError::InvalidNegativeRepeatBoundary {
                        entry: entry_index,
                    });
                }
                ceil_positive_div(next_start - start, entry.d)?
            } else {
                let bound = period_media_end
                    .ok_or(TimelineError::UnboundedNegativeRepeat { entry: entry_index })?;
                if bound <= start {
                    return Err(TimelineError::InvalidNegativeRepeatBoundary {
                        entry: entry_index,
                    });
                }
                ceil_positive_div(bound - start, entry.d)?
            };

            let run = TimelineRun {
                media_start: start,
                duration: entry.d,
                count,
                first_position: next_position,
                source_entry: entry_index,
                last_end_override: None,
            };
            next_position = next_position
                .checked_add(count)
                .ok_or(TimelineError::Overflow)?;
            cursor = start
                .checked_add(
                    entry
                        .d
                        .checked_mul(i128::from(count))
                        .ok_or(TimelineError::Overflow)?,
                )
                .ok_or(TimelineError::Overflow)?;
            runs.push(run);
        }

        let mut timeline = Self {
            timescale,
            presentation_time_offset,
            period_start,
            period_end,
            runs,
        };
        timeline.clip_to_period()?;
        Ok(timeline)
    }

    pub(crate) fn first_position(&self) -> Option<u64> {
        self.runs.first().map(|run| run.first_position)
    }

    pub(crate) fn last_position(&self) -> Option<u64> {
        self.runs.last().and_then(TimelineRun::last_position)
    }

    pub(crate) fn run_count(&self) -> usize {
        self.runs.len()
    }

    pub(crate) fn represented_segment_count(&self) -> u128 {
        self.runs.iter().map(|run| u128::from(run.count)).sum()
    }

    #[cfg(test)]
    fn allocated_run_bytes(&self) -> usize {
        self.runs.capacity() * std::mem::size_of::<TimelineRun>()
    }

    pub(crate) fn get(&self, position: u64) -> Result<Option<SegmentRef>, TimelineError> {
        let run_index = self
            .runs
            .partition_point(|run| run.first_position <= position);
        let Some(run_index) = run_index.checked_sub(1) else {
            return Ok(None);
        };
        let Some(run) = self.runs.get(run_index) else {
            return Ok(None);
        };
        let Some(offset) = position.checked_sub(run.first_position) else {
            return Ok(None);
        };
        if offset >= run.count {
            return Ok(None);
        }
        let media_start = run.media_start_at(offset).ok_or(TimelineError::Overflow)?;
        let media_end = run.media_end_at(offset).ok_or(TimelineError::Overflow)?;
        let mut presentation_start = presentation_time(
            media_start,
            self.timescale,
            self.period_start,
            self.presentation_time_offset,
        )?;
        let mut presentation_end = presentation_time(
            media_end,
            self.timescale,
            self.period_start,
            self.presentation_time_offset,
        )?;
        presentation_start = presentation_start.max(self.period_start);
        if let Some(period_end) = self.period_end {
            presentation_end = presentation_end.min(period_end);
        }
        Ok(
            (presentation_start < presentation_end).then_some(SegmentRef {
                position,
                media_time: media_start,
                presentation_start,
                presentation_end,
                source_entry: run.source_entry,
            }),
        )
    }

    pub(crate) fn find(&self, time: ExactTime) -> Result<Option<u64>, TimelineError> {
        if time < self.period_start || self.period_end.is_some_and(|end| time >= end) {
            return Ok(None);
        }
        let mut low = 0_usize;
        let mut high = self.runs.len();
        while low < high {
            let middle = low + (high - low) / 2;
            let run = &self.runs[middle];
            let start = presentation_time(
                run.media_start,
                self.timescale,
                self.period_start,
                self.presentation_time_offset,
            )?;
            if start <= time {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        let Some(run_index) = low.checked_sub(1) else {
            return Ok(None);
        };
        let run = &self.runs[run_index];
        let media_time = time.checked_sub(self.period_start).and_then(|relative| {
            relative.checked_add(ExactTime::new(
                self.presentation_time_offset,
                self.timescale,
            )?)
        })?;
        let relative_ticks = media_time
            .checked_sub(ExactTime::new(run.media_start, self.timescale)?)?
            .rescale(self.timescale, Rounding::Floor)?;
        let guessed_offset = if relative_ticks <= 0 {
            0
        } else {
            u64::try_from(relative_ticks / run.duration).map_err(|_| TimelineError::Overflow)?
        }
        .min(run.count.saturating_sub(1));
        let position = run
            .first_position
            .checked_add(guessed_offset)
            .ok_or(TimelineError::Overflow)?;
        let Some(reference) = self.get(position)? else {
            return Ok(None);
        };
        Ok(
            (reference.presentation_start <= time && time < reference.presentation_end)
                .then_some(position),
        )
    }

    /// Removes references whose (Period-clipped) end is at or before `time`.
    /// Absolute positions/segment numbers of retained references do not change.
    pub(crate) fn evict_before(&mut self, time: ExactTime) -> Result<(), TimelineError> {
        let mut whole_runs = 0;
        for run in &self.runs {
            let last_position = run.last_position().ok_or(TimelineError::Overflow)?;
            let Some(reference) = self.get(last_position)? else {
                return Err(TimelineError::Overflow);
            };
            if reference.presentation_end > time {
                break;
            }
            whole_runs += 1;
        }
        if whole_runs > 0 {
            self.runs.drain(..whole_runs);
        }

        let Some(first) = self.runs.first() else {
            return Ok(());
        };
        let mut low = 0_u64;
        let mut high = first.count;
        while low < high {
            let middle = low + (high - low) / 2;
            let position = first.first_position + middle;
            if self
                .get(position)?
                .is_some_and(|reference| reference.presentation_end <= time)
            {
                low = middle + 1;
            } else {
                high = middle;
            }
        }
        if low > 0 {
            let run = &mut self.runs[0];
            let Some(new_start) = run.media_start_at(low) else {
                return Err(TimelineError::Overflow);
            };
            run.media_start = new_start;
            run.first_position = run
                .first_position
                .checked_add(low)
                .ok_or(TimelineError::Overflow)?;
            run.count -= low;
        }
        Ok(())
    }

    fn clip_to_period(&mut self) -> Result<(), TimelineError> {
        let mut clipped = Vec::with_capacity(self.runs.len());
        for mut run in self.runs.drain(..) {
            let original_count = run.count;
            let final_effective_end = run
                .media_end_at(run.count - 1)
                .ok_or(TimelineError::Overflow)?;
            let lower_delta = self
                .presentation_time_offset
                .checked_sub(run.media_start)
                .ok_or(TimelineError::Overflow)?;
            let non_final_count = run.count - 1;
            let regular_skip = if lower_delta <= 0 {
                0
            } else {
                u64::try_from(lower_delta / run.duration)
                    .map_err(|_| TimelineError::Overflow)?
                    .min(non_final_count)
            };
            let skip = if regular_skip == non_final_count
                && final_effective_end <= self.presentation_time_offset
            {
                run.count
            } else {
                regular_skip
            };
            if skip > 0 {
                run.media_start = run.media_start_at(skip).ok_or(TimelineError::Overflow)?;
                run.first_position = run
                    .first_position
                    .checked_add(skip)
                    .ok_or(TimelineError::Overflow)?;
                run.count -= skip;
            }
            if let Some(period_end) = self.period_end {
                let end_media_ceiling = period_end
                    .checked_sub(self.period_start)?
                    .rescale(self.timescale, Rounding::Ceil)?
                    .checked_add(self.presentation_time_offset)
                    .ok_or(TimelineError::Overflow)?;
                let delta = end_media_ceiling
                    .checked_sub(run.media_start)
                    .ok_or(TimelineError::Overflow)?;
                let keep = if delta <= 0 {
                    0
                } else {
                    ceil_positive_div(delta, run.duration)?.min(run.count)
                };
                run.count = keep;
            }
            if run.count > 0 {
                if skip + run.count < original_count {
                    run.last_end_override = None;
                }
                clipped.push(run);
            }
        }
        self.runs = clipped;
        Ok(())
    }
}

fn ceil_positive_div(numerator: i128, denominator: i128) -> Result<u64, TimelineError> {
    debug_assert!(numerator > 0 && denominator > 0);
    let quotient = numerator / denominator;
    let rounded = quotient
        .checked_add(i128::from(numerator % denominator != 0))
        .ok_or(TimelineError::Overflow)?;
    u64::try_from(rounded).map_err(|_| TimelineError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn seconds(value: i128) -> ExactTime {
        ExactTime::new(value, 1).unwrap()
    }

    fn entry(t: Option<i128>, d: i128, r: i64) -> TimelineEntry {
        TimelineEntry { t, d, r }
    }

    fn timeline(
        entries: &[TimelineEntry],
        scale: u64,
        pto: i128,
        start_number: u64,
        period_start: ExactTime,
        duration: Option<ExactTime>,
    ) -> CompactTimeline {
        CompactTimeline::new(entries, scale, pto, start_number, period_start, duration).unwrap()
    }

    #[test]
    fn exact_90000_tick_and_explicit_rounding() {
        let tick = ExactTime::new(1, 90_000).unwrap();
        assert_eq!((tick.numerator(), tick.denominator()), (1, 90_000));
        assert_eq!(tick.rescale(1_000, Rounding::Floor), Ok(0));
        assert_eq!(tick.rescale(1_000, Rounding::Ceil), Ok(1));
        assert_eq!(tick.rescale(1_000, Rounding::TowardZero), Ok(0));
        assert_eq!(tick.rescale(1_000, Rounding::AwayFromZero), Ok(1));
        assert_eq!(
            ExactTime::new(1, 2)
                .unwrap()
                .rescale(1, Rounding::NearestTiesAway),
            Ok(1)
        );
        assert_eq!(
            ExactTime::new(-1, 2)
                .unwrap()
                .rescale(1, Rounding::NearestTiesAway),
            Ok(-1)
        );
    }

    #[test]
    fn large_and_negative_exact_times() {
        let large = ExactTime::new(i128::from(i64::MAX) * 90_000, 90_000).unwrap();
        assert_eq!(large, ExactTime::new(i128::from(i64::MAX), 1).unwrap());
        let negative = ExactTime::new(-90_001, 90_000).unwrap();
        assert_eq!(negative.rescale(1, Rounding::Floor), Ok(-2));
        assert_eq!(negative.rescale(1, Rounding::Ceil), Ok(-1));
        assert_eq!(negative.rescale(1, Rounding::TowardZero), Ok(-1));
    }

    #[test]
    fn unrelated_timescales_rescale_without_float() {
        let source = ExactTime::new(1001, 30_000).unwrap();
        assert_eq!(source.rescale(44_100, Rounding::Floor), Ok(1_471));
        assert_eq!(source.rescale(44_100, Rounding::Ceil), Ok(1_472));
        assert_eq!(source.rescale(90_000, Rounding::NearestTiesAway), Ok(3_003));
    }

    #[test]
    fn invalid_scale_and_rescale_overflow_are_reported() {
        assert_eq!(ExactTime::new(1, 0), Err(TimeError::ZeroTimescale));
        let huge = ExactTime::new(i128::MAX, 1).unwrap();
        assert_eq!(huge.rescale(2, Rounding::Floor), Err(TimeError::Overflow));
    }

    #[test]
    fn presentation_conversion_combines_period_and_pto_exactly() {
        // 180000/90000 + 10 - 45000/90000 = 23/2.
        let converted = presentation_time(180_000, 90_000, seconds(10), 45_000).unwrap();
        assert_eq!(converted, ExactTime::new(23, 2).unwrap());
        let with_negative_offset = presentation_time(-45_000, 90_000, seconds(10), 45_000).unwrap();
        assert_eq!(with_negative_offset, seconds(9));
    }

    #[test]
    fn missing_t_continues_from_previous_run() {
        let index = timeline(
            &[entry(Some(0), 10, 1), entry(None, 5, 1)],
            1,
            0,
            1,
            ExactTime::ZERO,
            Some(seconds(30)),
        );
        assert_eq!(index.run_count(), 2);
        assert_eq!(index.get(3).unwrap().unwrap().media_time, 20);
        assert_eq!(index.get(4).unwrap().unwrap().media_time, 25);
    }

    #[test]
    fn positive_repeat_is_one_compact_run() {
        let index = timeline(
            &[entry(Some(0), 2, 4)],
            1,
            0,
            7,
            ExactTime::ZERO,
            Some(seconds(10)),
        );
        assert_eq!(
            (index.run_count(), index.represented_segment_count()),
            (1, 5)
        );
        assert_eq!(
            (index.first_position(), index.last_position()),
            (Some(7), Some(11))
        );
        assert_eq!(index.find(ExactTime::new(9, 1).unwrap()), Ok(Some(11)));
    }

    #[test]
    fn negative_repeat_resolves_against_next_explicit_t() {
        let index = timeline(
            &[entry(Some(0), 4, -1), entry(Some(10), 2, 0)],
            1,
            0,
            1,
            ExactTime::ZERO,
            Some(seconds(12)),
        );
        assert_eq!(index.represented_segment_count(), 4);
        assert_eq!(index.get(3).unwrap().unwrap().presentation_end, seconds(10));
        assert_eq!(
            index.get(4).unwrap().unwrap().presentation_start,
            seconds(10)
        );
    }

    #[test]
    fn terminal_negative_repeat_is_bounded_by_period() {
        let index = timeline(
            &[entry(Some(0), 3, -1)],
            1,
            0,
            20,
            seconds(100),
            Some(seconds(10)),
        );
        assert_eq!(index.represented_segment_count(), 4);
        let last = index.get(23).unwrap().unwrap();
        assert_eq!(last.presentation_start, seconds(109));
        assert_eq!(last.presentation_end, seconds(110));
    }

    #[test]
    fn terminal_negative_repeat_combines_period_start_pto_and_finite_duration() {
        let index = timeline(
            &[entry(Some(45_000), 90_000, -1)],
            90_000,
            45_000,
            100,
            seconds(100),
            Some(ExactTime::new(5, 2).unwrap()),
        );
        assert_eq!(index.represented_segment_count(), 3);
        assert_eq!(
            (index.first_position(), index.last_position()),
            (Some(100), Some(102))
        );
        let last = index.get(102).unwrap().unwrap();
        assert_eq!(last.presentation_start, seconds(102));
        assert_eq!(last.presentation_end, ExactTime::new(205, 2).unwrap());
    }

    #[test]
    fn terminal_negative_repeat_without_finite_period_is_rejected() {
        let result = CompactTimeline::new(&[entry(Some(0), 3, -1)], 1, 0, 1, ExactTime::ZERO, None);
        assert_eq!(
            result.unwrap_err(),
            TimelineError::UnboundedNegativeRepeat { entry: 0 }
        );
    }

    #[test]
    fn gap_stretches_previous_reference_to_next_t() {
        let index = timeline(
            &[entry(Some(0), 5, 0), entry(Some(8), 2, 0)],
            1,
            0,
            1,
            ExactTime::ZERO,
            Some(seconds(10)),
        );
        assert_eq!(index.get(1).unwrap().unwrap().presentation_end, seconds(8));
        assert_eq!(index.find(seconds(7)), Ok(Some(1)));
        assert_eq!(index.find(seconds(8)), Ok(Some(2)));
    }

    #[test]
    fn leading_period_clip_keeps_gap_extended_final_reference() {
        let index = timeline(
            &[entry(Some(0), 5, 0), entry(Some(8), 2, 0)],
            1,
            6,
            1,
            ExactTime::ZERO,
            Some(seconds(4)),
        );
        assert_eq!(index.first_position(), Some(1));
        let first = index.get(1).unwrap().unwrap();
        assert_eq!(first.media_time, 0);
        assert_eq!(first.presentation_start, ExactTime::ZERO);
        assert_eq!(first.presentation_end, seconds(2));
    }

    #[test]
    fn overlap_clips_previous_reference_to_next_t() {
        let index = timeline(
            &[entry(Some(0), 10, 0), entry(Some(8), 2, 0)],
            1,
            0,
            1,
            ExactTime::ZERO,
            Some(seconds(10)),
        );
        assert_eq!(index.get(1).unwrap().unwrap().presentation_end, seconds(8));
        assert_eq!(index.find(seconds(8)), Ok(Some(2)));
    }

    #[test]
    fn leading_period_clip_removes_overlap_shortened_final_reference() {
        let index = timeline(
            &[entry(Some(0), 10, 0), entry(Some(8), 2, 0)],
            1,
            9,
            1,
            ExactTime::ZERO,
            Some(seconds(1)),
        );
        assert_eq!(index.first_position(), Some(2));
        assert_eq!(index.get(1), Ok(None));
        assert!(index
            .get(index.first_position().unwrap())
            .unwrap()
            .is_some());
    }

    #[test]
    fn explicit_start_must_follow_previous_final_segment_start() {
        let invalid = CompactTimeline::new(
            &[entry(Some(0), 10, 2), entry(Some(15), 5, 0)],
            1,
            0,
            1,
            ExactTime::ZERO,
            Some(seconds(30)),
        );
        assert_eq!(
            invalid.unwrap_err(),
            TimelineError::NonMonotonicStart { entry: 1 }
        );

        let valid = timeline(
            &[entry(Some(0), 10, 2), entry(Some(25), 5, 0)],
            1,
            0,
            1,
            ExactTime::ZERO,
            Some(seconds(30)),
        );
        assert_eq!(
            valid.get(3).unwrap().unwrap().presentation_start,
            seconds(20)
        );
        assert_eq!(valid.get(3).unwrap().unwrap().presentation_end, seconds(25));
        assert_eq!(
            valid.get(4).unwrap().unwrap().presentation_start,
            seconds(25)
        );
    }

    #[test]
    fn pto_and_nonzero_period_start_place_references() {
        let index = timeline(
            &[entry(Some(90_000), 45_000, 1)],
            90_000,
            45_000,
            42,
            seconds(30),
            Some(seconds(1)),
        );
        let first = index.get(42).unwrap().unwrap();
        assert_eq!(first.presentation_start, ExactTime::new(61, 2).unwrap());
        assert_eq!(first.presentation_end, seconds(31));
        assert_eq!(index.get(43), Ok(None)); // clipped wholly at the Period boundary
    }

    #[test]
    fn period_clips_leading_and_trailing_segments_but_keeps_numbers() {
        let index = timeline(
            &[entry(Some(0), 5, 4)],
            1,
            5,
            100,
            seconds(20),
            Some(seconds(12)),
        );
        assert_eq!(
            (index.first_position(), index.last_position()),
            (Some(101), Some(103))
        );
        assert_eq!(
            index.get(101).unwrap().unwrap().presentation_start,
            seconds(20)
        );
        assert_eq!(
            index.get(103).unwrap().unwrap().presentation_end,
            seconds(32)
        );
    }

    #[test]
    fn find_and_get_binary_search_across_runs() {
        let index = timeline(
            &[
                entry(Some(0), 2, 2),
                entry(Some(6), 3, 1),
                entry(Some(12), 1, 2),
            ],
            1,
            0,
            10,
            ExactTime::ZERO,
            Some(seconds(15)),
        );
        assert_eq!(index.find(ExactTime::new(13, 1).unwrap()), Ok(Some(16)));
        assert_eq!(index.get(16).unwrap().unwrap().media_time, 13);
        assert_eq!(index.get(9), Ok(None));
        assert_eq!(index.get(19), Ok(None));
    }

    #[test]
    fn lookup_distinguishes_absent_reference_from_arithmetic_failure() {
        let index = timeline(
            &[entry(Some(i128::MAX - 1), 1, 0)],
            1,
            0,
            1,
            seconds(2),
            None,
        );
        assert_eq!(index.get(2), Ok(None));
        assert_eq!(index.get(1), Err(TimelineError::Time(TimeError::Overflow)));
        assert_eq!(
            index.find(seconds(2)),
            Err(TimelineError::Time(TimeError::Overflow))
        );
    }

    #[test]
    fn eviction_preserves_absolute_positions() {
        let mut index = timeline(
            &[entry(Some(0), 2, 4), entry(None, 5, 1)],
            1,
            0,
            50,
            ExactTime::ZERO,
            Some(seconds(20)),
        );
        index.evict_before(seconds(7)).unwrap();
        assert_eq!(index.first_position(), Some(53));
        assert_eq!(index.get(52), Ok(None));
        assert_eq!(index.get(53).unwrap().unwrap().media_time, 6);
        assert_eq!(index.find(seconds(7)), Ok(Some(53)));
        assert_eq!(index.last_position(), Some(56));
    }

    #[test]
    fn million_segments_remain_one_run() {
        let started = Instant::now();
        let index = timeline(
            &[entry(Some(0), 9_000, 999_999)],
            90_000,
            0,
            1,
            ExactTime::ZERO,
            Some(seconds(100_000)),
        );
        let elapsed = started.elapsed();
        assert_eq!(index.represented_segment_count(), 1_000_000);
        assert_eq!(index.run_count(), 1);
        assert!(index.allocated_run_bytes() < 1_024);
        assert_eq!(
            index.find(ExactTime::new(99_999_999, 1_000).unwrap()),
            Ok(Some(1_000_000))
        );
        eprintln!(
            "million-segment compact run: {} run(s), {} allocated run bytes, {:?}",
            index.run_count(),
            index.allocated_run_bytes(),
            elapsed
        );
    }
}
