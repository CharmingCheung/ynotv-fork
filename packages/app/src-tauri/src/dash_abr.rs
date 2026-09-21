//! Pure, replaceable DASH video ABR policy.
//!
//! The controller observes completed video-media HTTP transfers and buffer
//! health, then proposes a stable Representation ID. It never performs I/O or
//! mutates the DASH scheduler/mpv pipeline.

use serde::Serialize;
use std::{
    collections::VecDeque,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type", content = "representationId", rename_all = "camelCase")]
pub(crate) enum VideoQualityMode {
    Auto,
    Manual(String),
}

impl Default for VideoQualityMode {
    fn default() -> Self {
        Self::Auto
    }
}

#[derive(Clone, Debug)]
pub(crate) struct AbrRepresentation {
    pub id: String,
    pub bandwidth: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BufferZone {
    Critical,
    Low,
    Healthy,
}

impl BufferZone {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Critical => "critical",
            Self::Low => "low",
            Self::Healthy => "normal",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AbrReason {
    CriticalBuffer,
    LowBuffer,
    BandwidthDown,
    RepeatedFailures,
    BandwidthUp,
}

impl AbrReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CriticalBuffer => "critical_buffer",
            Self::LowBuffer => "low_buffer",
            Self::BandwidthDown => "bandwidth_down",
            Self::RepeatedFailures => "repeated_fetch_failures",
            Self::BandwidthUp => "bandwidth_up",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AbrDecision {
    Hold(&'static str),
    Switch {
        target_id: String,
        reason: AbrReason,
        emergency: bool,
    },
}

#[derive(Clone, Debug)]
pub(crate) struct AbrPolicy {
    /// Latest-sample weight while fewer than `stable_sample_count` exist.
    pub startup_ewma_alpha: f64,
    /// Latest-sample weight after the estimate is established.
    pub established_ewma_alpha: f64,
    pub stable_sample_count: usize,
    pub safety_factor: f64,
    pub critical_buffer_seconds: f64,
    pub low_buffer_seconds: f64,
    pub upswitch_headroom: f64,
    pub upswitch_sample_count: usize,
    pub switch_cooldown: Duration,
    pub failures_before_downswitch: u32,
    pub history_capacity: usize,
}

impl Default for AbrPolicy {
    fn default() -> Self {
        Self {
            startup_ewma_alpha: 0.65,
            established_ewma_alpha: 0.30,
            stable_sample_count: 3,
            safety_factor: 0.80,
            critical_buffer_seconds: 1.0,
            low_buffer_seconds: 2.0,
            upswitch_headroom: 1.0,
            upswitch_sample_count: 2,
            switch_cooldown: Duration::from_secs(8),
            failures_before_downswitch: 2,
            history_capacity: 20,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct DownloadMeasurement {
    pub representation_id: String,
    pub bytes: usize,
    pub request_start: Instant,
    pub first_byte_time: Option<Instant>,
    pub request_end: Instant,
}

#[derive(Clone, Debug)]
pub(crate) struct ThroughputSample {
    pub representation_id: String,
    pub bytes: usize,
    pub request_start: Instant,
    pub first_byte_time: Option<Instant>,
    pub request_end: Instant,
    pub download_duration: Duration,
    pub throughput_bps: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AbrStatistics {
    pub throughput_sample_count: u64,
    pub current_estimate: Option<f64>,
    pub current_safe_bandwidth: Option<f64>,
    pub current_representation: String,
    pub abr_switch_count: u64,
    pub down_switch_count: u64,
    pub up_switch_count: u64,
    pub last_switch_reason: Option<String>,
    pub buffered_seconds: Option<f64>,
    pub minimum_observed_buffered_seconds: Option<f64>,
    pub maximum_observed_buffered_seconds: Option<f64>,
}

#[derive(Clone, Debug)]
pub(crate) struct AbrEvaluation {
    pub decision: AbrDecision,
    pub current: AbrRepresentation,
    pub candidate: Option<AbrRepresentation>,
    pub latest_throughput_bps: Option<f64>,
    pub estimate_bps: Option<f64>,
    pub safety_factor: f64,
    pub safe_bandwidth_bps: Option<f64>,
    pub buffered_seconds: Option<f64>,
    pub buffer_zone: BufferZone,
    pub upswitch_headroom: f64,
    pub required_estimate_bps: Option<f64>,
    pub sample_count: usize,
    pub stable_sample_count: usize,
    pub supporting_sample_count: usize,
    pub required_supporting_sample_count: usize,
    pub cooldown_remaining: Duration,
}

pub(crate) struct AbrController {
    policy: AbrPolicy,
    mode: VideoQualityMode,
    estimate_bps: Option<f64>,
    samples: VecDeque<ThroughputSample>,
    consecutive_failures: u32,
    last_switch_time: Option<Instant>,
    stats: AbrStatistics,
}

impl AbrController {
    pub(crate) fn new(policy: AbrPolicy, mode: VideoQualityMode, current: String) -> Self {
        Self {
            policy,
            mode,
            estimate_bps: None,
            samples: VecDeque::new(),
            consecutive_failures: 0,
            last_switch_time: None,
            stats: AbrStatistics {
                current_representation: current,
                ..AbrStatistics::default()
            },
        }
    }

    pub(crate) fn set_mode(&mut self, mode: VideoQualityMode) {
        self.mode = mode;
    }

    pub(crate) fn mode(&self) -> &VideoQualityMode {
        &self.mode
    }

    /// Records a complete media response. Duration intentionally includes TTFB:
    /// request start through receipt of the final response byte.
    pub(crate) fn observe_download(&mut self, measurement: DownloadMeasurement) -> bool {
        let duration = measurement
            .request_end
            .saturating_duration_since(measurement.request_start);
        if measurement.bytes == 0 || duration.is_zero() {
            return false;
        }
        let throughput_bps = measurement.bytes as f64 * 8.0 / duration.as_secs_f64();
        if !throughput_bps.is_finite() || throughput_bps <= 0.0 {
            return false;
        }
        let alpha = if self.samples.len() < self.policy.stable_sample_count {
            self.policy.startup_ewma_alpha
        } else {
            self.policy.established_ewma_alpha
        };
        self.estimate_bps = Some(match self.estimate_bps {
            Some(previous) => alpha * throughput_bps + (1.0 - alpha) * previous,
            None => throughput_bps,
        });
        self.samples.push_back(ThroughputSample {
            representation_id: measurement.representation_id,
            bytes: measurement.bytes,
            request_start: measurement.request_start,
            first_byte_time: measurement.first_byte_time,
            request_end: measurement.request_end,
            download_duration: duration,
            throughput_bps,
        });
        while self.samples.len() > self.policy.history_capacity {
            self.samples.pop_front();
        }
        self.consecutive_failures = 0;
        self.stats.throughput_sample_count += 1;
        self.stats.current_estimate = self.estimate_bps;
        self.stats.current_safe_bandwidth = self.safe_bandwidth();
        true
    }

    pub(crate) fn observe_failed_download(&mut self) {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
    }

    pub(crate) fn observe_buffer(&mut self, buffered_seconds: Option<f64>) {
        let value = buffered_seconds.filter(|value| value.is_finite() && *value >= 0.0);
        self.stats.buffered_seconds = value;
        if let Some(value) = value {
            self.stats.minimum_observed_buffered_seconds = Some(
                self.stats
                    .minimum_observed_buffered_seconds
                    .map_or(value, |old| old.min(value)),
            );
            self.stats.maximum_observed_buffered_seconds = Some(
                self.stats
                    .maximum_observed_buffered_seconds
                    .map_or(value, |old| old.max(value)),
            );
        }
    }

    pub(crate) fn safe_bandwidth(&self) -> Option<f64> {
        self.estimate_bps
            .map(|estimate| estimate * self.policy.safety_factor)
    }

    pub(crate) fn has_stable_estimate(&self) -> bool {
        self.samples.len() >= self.policy.stable_sample_count
    }

    pub(crate) fn recent_samples(&self) -> &VecDeque<ThroughputSample> {
        &self.samples
    }

    pub(crate) fn consecutive_failures(&self) -> u32 {
        self.consecutive_failures
    }

    pub(crate) fn statistics(&self) -> AbrStatistics {
        self.stats.clone()
    }

    pub(crate) fn buffer_zone(&self) -> BufferZone {
        match self.stats.buffered_seconds {
            Some(value) if value < self.policy.critical_buffer_seconds => BufferZone::Critical,
            Some(value) if value < self.policy.low_buffer_seconds => BufferZone::Low,
            Some(_) => BufferZone::Healthy,
            None => BufferZone::Low,
        }
    }

    pub(crate) fn choose_representation(
        &self,
        now: Instant,
        current_id: &str,
        available: &[AbrRepresentation],
        pending_target: Option<&str>,
    ) -> AbrDecision {
        if !matches!(self.mode, VideoQualityMode::Auto) {
            return AbrDecision::Hold("manual_mode");
        }
        let mut ladder = available.to_vec();
        ladder.sort_by_key(|representation| (representation.bandwidth, representation.id.clone()));
        let Some(current_index) = ladder
            .iter()
            .position(|representation| representation.id == current_id)
        else {
            return AbrDecision::Hold("current_not_in_catalog");
        };
        if ladder.len() < 2 {
            return AbrDecision::Hold("single_representation");
        }
        let zone = self.buffer_zone();
        if zone == BufferZone::Critical && current_index > 0 {
            return self.switch_or_pending(
                &ladder[0].id,
                pending_target,
                AbrReason::CriticalBuffer,
                true,
            );
        }
        if self.consecutive_failures >= self.policy.failures_before_downswitch && current_index > 0
        {
            if self.in_cooldown(now) {
                return AbrDecision::Hold("failure_downswitch_cooldown_active");
            }
            return self.switch_or_pending(
                &ladder[current_index - 1].id,
                pending_target,
                AbrReason::RepeatedFailures,
                false,
            );
        }
        let Some(safe_bandwidth) = self.safe_bandwidth() else {
            return AbrDecision::Hold("estimate_unknown");
        };
        let fitting_index = ladder
            .iter()
            .rposition(|representation| representation.bandwidth as f64 <= safe_bandwidth)
            .unwrap_or(0);
        if fitting_index < current_index {
            if self.in_cooldown(now) {
                return AbrDecision::Hold("downswitch_cooldown_active");
            }
            let reason = if zone == BufferZone::Low {
                AbrReason::LowBuffer
            } else {
                AbrReason::BandwidthDown
            };
            return self.switch_or_pending(
                &ladder[fitting_index].id,
                pending_target,
                reason,
                false,
            );
        }
        if zone != BufferZone::Healthy {
            return AbrDecision::Hold(if self.stats.buffered_seconds.is_some() {
                "low_buffer_upswitch_veto"
            } else {
                "buffer_unknown_upswitch_veto"
            });
        }
        if fitting_index > current_index {
            if !self.has_stable_estimate() {
                return AbrDecision::Hold("estimator_confidence_below_minimum");
            }
            if self.in_cooldown(now) {
                return AbrDecision::Hold("upswitch_cooldown_active");
            }
            // Raise at most one rung per decision. This keeps startup and recovery gradual.
            let target = &ladder[current_index + 1];
            let required = target.bandwidth as f64 * self.policy.upswitch_headroom;
            if safe_bandwidth < required {
                return AbrDecision::Hold("safe_bandwidth_below_candidate");
            }
            if self.supporting_sample_count(required) < self.policy.upswitch_sample_count {
                return AbrDecision::Hold("insufficient_recent_supporting_samples");
            }
            return self.switch_or_pending(
                &target.id,
                pending_target,
                AbrReason::BandwidthUp,
                false,
            );
        }
        AbrDecision::Hold(if current_index + 1 < ladder.len() {
            "safe_bandwidth_below_candidate"
        } else {
            "current_is_highest_representation"
        })
    }

    pub(crate) fn evaluate(
        &self,
        now: Instant,
        current_id: &str,
        available: &[AbrRepresentation],
        pending_target: Option<&str>,
    ) -> Option<AbrEvaluation> {
        let mut ladder = available.to_vec();
        ladder.sort_by_key(|representation| (representation.bandwidth, representation.id.clone()));
        let current_index = ladder
            .iter()
            .position(|representation| representation.id == current_id)?;
        let current = ladder[current_index].clone();
        let candidate = ladder.get(current_index + 1).cloned();
        let required_safe = candidate
            .as_ref()
            .map(|target| target.bandwidth as f64 * self.policy.upswitch_headroom);
        Some(AbrEvaluation {
            decision: self.choose_representation(now, current_id, available, pending_target),
            current,
            candidate,
            latest_throughput_bps: self.samples.back().map(|sample| sample.throughput_bps),
            estimate_bps: self.estimate_bps,
            safety_factor: self.policy.safety_factor,
            safe_bandwidth_bps: self.safe_bandwidth(),
            buffered_seconds: self.stats.buffered_seconds,
            buffer_zone: self.buffer_zone(),
            upswitch_headroom: self.policy.upswitch_headroom,
            required_estimate_bps: required_safe
                .map(|required| required / self.policy.safety_factor),
            sample_count: self.samples.len(),
            stable_sample_count: self.policy.stable_sample_count,
            supporting_sample_count: required_safe
                .map_or(0, |required| self.supporting_sample_count(required)),
            required_supporting_sample_count: self.policy.upswitch_sample_count,
            cooldown_remaining: self.cooldown_remaining(now),
        })
    }

    pub(crate) fn switch_completed(
        &mut self,
        now: Instant,
        from_bandwidth: u64,
        to: &AbrRepresentation,
        reason: AbrReason,
    ) {
        self.last_switch_time = Some(now);
        self.stats.current_representation = to.id.clone();
        self.stats.abr_switch_count += 1;
        if to.bandwidth > from_bandwidth {
            self.stats.up_switch_count += 1;
        } else if to.bandwidth < from_bandwidth {
            self.stats.down_switch_count += 1;
        }
        self.stats.last_switch_reason = Some(reason.as_str().to_string());
    }

    pub(crate) fn note_current_representation(&mut self, representation_id: &str) {
        self.stats.current_representation = representation_id.to_string();
    }

    pub(crate) fn external_switch_completed(&mut self, now: Instant, representation_id: &str) {
        self.last_switch_time = Some(now);
        self.note_current_representation(representation_id);
    }

    fn in_cooldown(&self, now: Instant) -> bool {
        !self.cooldown_remaining(now).is_zero()
    }

    fn cooldown_remaining(&self, now: Instant) -> Duration {
        self.last_switch_time.map_or(Duration::ZERO, |last| {
            self.policy
                .switch_cooldown
                .saturating_sub(now.saturating_duration_since(last))
        })
    }

    fn supporting_sample_count(&self, required_safe_bandwidth: f64) -> usize {
        self.samples
            .iter()
            .rev()
            .take_while(|sample| {
                sample.throughput_bps * self.policy.safety_factor >= required_safe_bandwidth
            })
            .count()
    }

    fn switch_or_pending(
        &self,
        target: &str,
        pending: Option<&str>,
        reason: AbrReason,
        emergency: bool,
    ) -> AbrDecision {
        if pending == Some(target) {
            AbrDecision::Hold("target_already_pending")
        } else {
            AbrDecision::Switch {
                target_id: target.to_string(),
                reason,
                emergency,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ladder() -> Vec<AbrRepresentation> {
        [500_000, 1_000_000, 2_000_000, 4_000_000, 8_000_000]
            .into_iter()
            .map(|bandwidth| AbrRepresentation {
                id: format!("v{bandwidth}"),
                bandwidth,
            })
            .collect()
    }

    fn sample(controller: &mut AbrController, now: Instant, mbps: f64) {
        let duration = Duration::from_secs(1);
        let bytes = (mbps * 1_000_000.0 / 8.0) as usize;
        assert!(controller.observe_download(DownloadMeasurement {
            representation_id: "fixture".into(),
            bytes,
            request_start: now,
            first_byte_time: Some(now),
            request_end: now + duration
        }));
    }

    fn controller(current: &str) -> AbrController {
        AbrController::new(AbrPolicy::default(), VideoQualityMode::Auto, current.into())
    }

    #[test]
    fn stable_fast_network_rises_gradually_without_per_sample_switching() {
        let start = Instant::now();
        let mut controller = controller("v2000000");
        controller.observe_buffer(Some(15.0));
        for (index, speed) in [10.0, 9.0, 11.0].into_iter().enumerate() {
            sample(
                &mut controller,
                start + Duration::from_secs(index as u64 * 10),
                speed,
            );
        }
        assert_eq!(
            controller.choose_representation(
                start + Duration::from_secs(30),
                "v2000000",
                &ladder(),
                None
            ),
            AbrDecision::Switch {
                target_id: "v4000000".into(),
                reason: AbrReason::BandwidthUp,
                emergency: false
            }
        );
        controller.switch_completed(
            start + Duration::from_secs(30),
            2_000_000,
            &ladder()[3],
            AbrReason::BandwidthUp,
        );
        sample(&mut controller, start + Duration::from_secs(31), 10.0);
        assert!(!matches!(
            controller.choose_representation(
                start + Duration::from_secs(31),
                "v4000000",
                &ladder(),
                None
            ),
            AbrDecision::Switch { .. }
        ));
    }

    #[test]
    fn ordinary_upswitch_respects_cooldown() {
        let start = Instant::now();
        let mut controller = controller("v1000000");
        controller.observe_buffer(Some(15.0));
        for index in 0..3 {
            sample(&mut controller, start + Duration::from_secs(index), 10.0);
        }
        controller.switch_completed(
            start + Duration::from_secs(3),
            1_000_000,
            &ladder()[2],
            AbrReason::BandwidthUp,
        );
        assert_eq!(
            controller.choose_representation(
                start + Duration::from_secs(4),
                "v2000000",
                &ladder(),
                None
            ),
            AbrDecision::Hold("upswitch_cooldown_active")
        );
    }

    #[test]
    fn sudden_collapse_switches_down_quickly() {
        let start = Instant::now();
        let mut controller = controller("v4000000");
        controller.observe_buffer(Some(15.0));
        for (index, speed) in [10.0, 9.0, 2.0, 1.5].into_iter().enumerate() {
            sample(
                &mut controller,
                start + Duration::from_secs(index as u64),
                speed,
            );
        }
        assert!(matches!(
            controller.choose_representation(
                start + Duration::from_secs(10),
                "v4000000",
                &ladder(),
                None
            ),
            AbrDecision::Switch {
                reason: AbrReason::BandwidthDown,
                ..
            }
        ));
    }

    #[test]
    fn recovery_requires_healthy_buffer_history_and_headroom() {
        let start = Instant::now();
        let mut controller = controller("v1000000");
        controller.observe_buffer(Some(15.0));
        for (index, speed) in [1.5, 1.8, 6.0, 7.0, 8.0].into_iter().enumerate() {
            sample(
                &mut controller,
                start + Duration::from_secs(index as u64 * 3),
                speed,
            );
        }
        assert!(
            matches!(controller.choose_representation(start + Duration::from_secs(20), "v1000000", &ladder(), None), AbrDecision::Switch { target_id, reason: AbrReason::BandwidthUp, .. } if target_id == "v2000000")
        );
    }

    #[test]
    fn noisy_network_has_hysteresis_and_no_ping_pong() {
        let start = Instant::now();
        let mut controller = controller("v2000000");
        controller.observe_buffer(Some(15.0));
        for (index, speed) in [5.0, 2.0, 6.0, 3.0, 5.0, 2.5].into_iter().enumerate() {
            sample(
                &mut controller,
                start + Duration::from_secs(index as u64),
                speed,
            );
        }
        assert!(!matches!(
            controller.choose_representation(
                start + Duration::from_secs(20),
                "v2000000",
                &ladder(),
                None
            ),
            AbrDecision::Switch {
                reason: AbrReason::BandwidthUp,
                ..
            }
        ));
    }

    #[test]
    fn low_buffer_blocks_up_and_critical_buffer_bypasses_cooldown() {
        let start = Instant::now();
        let mut controller = controller("v1000000");
        for index in 0..3 {
            sample(&mut controller, start + Duration::from_secs(index), 10.0);
        }
        controller.observe_buffer(Some(1.5));
        assert_eq!(
            controller.choose_representation(
                start + Duration::from_secs(10),
                "v1000000",
                &ladder(),
                None
            ),
            AbrDecision::Hold("low_buffer_upswitch_veto")
        );
        controller.observe_buffer(Some(15.0));
        controller.switch_completed(
            start + Duration::from_secs(10),
            1_000_000,
            &ladder()[2],
            AbrReason::BandwidthUp,
        );
        controller.observe_buffer(Some(0.5));
        assert_eq!(
            controller.choose_representation(
                start + Duration::from_secs(11),
                "v2000000",
                &ladder(),
                None
            ),
            AbrDecision::Switch {
                target_id: "v500000".into(),
                reason: AbrReason::CriticalBuffer,
                emergency: true
            }
        );
    }

    #[test]
    fn manual_mode_never_switches_and_failures_are_not_samples() {
        let start = Instant::now();
        let mut controller = AbrController::new(
            AbrPolicy::default(),
            VideoQualityMode::Manual("v4000000".into()),
            "v4000000".into(),
        );
        controller.observe_buffer(Some(0.5));
        controller.observe_failed_download();
        controller.observe_failed_download();
        assert_eq!(
            controller.choose_representation(start, "v4000000", &ladder(), None),
            AbrDecision::Hold("manual_mode")
        );
        assert_eq!(controller.statistics().throughput_sample_count, 0);
    }

    #[test]
    fn invalid_and_pending_samples_are_rejected_or_held() {
        let now = Instant::now();
        let mut controller = controller("v2000000");
        assert!(!controller.observe_download(DownloadMeasurement {
            representation_id: "v".into(),
            bytes: 0,
            request_start: now,
            first_byte_time: None,
            request_end: now
        }));
        controller.observe_buffer(Some(0.5));
        assert_eq!(
            controller.choose_representation(now, "v2000000", &ladder(), Some("v500000")),
            AbrDecision::Hold("target_already_pending")
        );
    }

    #[test]
    fn sustained_capacity_above_top_eventually_reaches_top() {
        let start = Instant::now();
        let mut controller = controller("v2000000");
        controller.observe_buffer(Some(3.5));
        for (index, speed) in [14.0, 15.0, 13.0].into_iter().enumerate() {
            sample(
                &mut controller,
                start + Duration::from_secs(index as u64),
                speed,
            );
        }
        assert!(matches!(
            controller.choose_representation(start + Duration::from_secs(3), "v2000000", &ladder(), None),
            AbrDecision::Switch { target_id, reason: AbrReason::BandwidthUp, .. } if target_id == "v4000000"
        ));
        controller.switch_completed(
            start + Duration::from_secs(3),
            2_000_000,
            &ladder()[3],
            AbrReason::BandwidthUp,
        );
        sample(&mut controller, start + Duration::from_secs(4), 14.0);
        sample(&mut controller, start + Duration::from_secs(5), 15.0);
        assert!(matches!(
            controller.choose_representation(start + Duration::from_secs(12), "v4000000", &ladder(), None),
            AbrDecision::Switch { target_id, reason: AbrReason::BandwidthUp, .. } if target_id == "v8000000"
        ));
    }

    #[test]
    fn marginal_capacity_above_top_may_hold_below_top() {
        let start = Instant::now();
        let mut controller = controller("v4000000");
        controller.observe_buffer(Some(3.5));
        for (index, speed) in [8.4, 8.7, 8.2, 8.6, 8.5].into_iter().enumerate() {
            sample(
                &mut controller,
                start + Duration::from_secs(index as u64),
                speed,
            );
        }
        assert_eq!(
            controller.choose_representation(
                start + Duration::from_secs(10),
                "v4000000",
                &ladder(),
                None
            ),
            AbrDecision::Hold("safe_bandwidth_below_candidate")
        );
    }

    #[test]
    fn strong_network_with_bounded_pipeline_buffer_can_reach_top() {
        let start = Instant::now();
        let mut controller = controller("v4000000");
        controller.observe_buffer(Some(2.5));
        for (index, speed) in [14.0, 15.0, 13.0].into_iter().enumerate() {
            sample(
                &mut controller,
                start + Duration::from_secs(index as u64),
                speed,
            );
        }
        let evaluation = controller
            .evaluate(start + Duration::from_secs(10), "v4000000", &ladder(), None)
            .unwrap();
        assert_eq!(evaluation.required_estimate_bps, Some(10_000_000.0));
        assert_eq!(evaluation.current.id, "v4000000");
        assert_eq!(evaluation.candidate.as_ref().unwrap().id, "v8000000");
        assert_eq!(evaluation.safety_factor, 0.80);
        assert_eq!(evaluation.buffered_seconds, Some(2.5));
        assert_eq!(evaluation.buffer_zone, BufferZone::Healthy);
        assert_eq!(evaluation.sample_count, 3);
        assert_eq!(evaluation.cooldown_remaining, Duration::ZERO);
        assert!(
            matches!(evaluation.decision, AbrDecision::Switch { target_id, .. } if target_id == "v8000000")
        );
    }

    #[test]
    fn effective_thresholds_use_one_bandwidth_reserve() {
        let policy = AbrPolicy::default();
        let thresholds = ladder()
            .iter()
            .map(|representation| {
                representation.bandwidth as f64 * policy.upswitch_headroom / policy.safety_factor
            })
            .collect::<Vec<_>>();
        assert_eq!(
            thresholds,
            vec![
                625_000.0,
                1_250_000.0,
                2_500_000.0,
                5_000_000.0,
                10_000_000.0
            ]
        );
    }

    #[test]
    fn request_throughput_includes_ttfb_and_exposes_measurement_bias() {
        let start = Instant::now();
        let mut controller = controller("v1000000");
        assert!(controller.observe_download(DownloadMeasurement {
            representation_id: "fixture".into(),
            bytes: 1_000_000,
            request_start: start,
            first_byte_time: Some(start + Duration::from_millis(400)),
            request_end: start + Duration::from_secs(1),
        }));
        let sample = controller.recent_samples().back().unwrap();
        assert_eq!(sample.download_duration, Duration::from_secs(1));
        assert_eq!(sample.throughput_bps, 8_000_000.0);
        assert_eq!(
            sample
                .request_end
                .duration_since(sample.first_byte_time.unwrap()),
            Duration::from_millis(600)
        );
    }
}
