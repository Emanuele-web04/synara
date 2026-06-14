from __future__ import annotations

import argparse
import json
import math
import struct
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterable


DEFAULT_APP_PATH = (
    Path.home()
    / ".codex/plugins/cache/openai-bundled/computer-use/1.0.750/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService"
)

TEXT_BASE_VM = 0x100000000


@dataclass(frozen=True)
class Section:
    segname: str
    sectname: str
    addr: int
    size: int
    offset: int


class MachOBinary:
    LC_SEGMENT_64 = 0x19

    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        self.sections = self._parse_sections()

    def _parse_sections(self) -> list[Section]:
        data = self.data
        magic = struct.unpack_from("<I", data, 0)[0]
        if magic != 0xFEEDFACF:
            raise ValueError(f"unsupported Mach-O magic: {magic:#x}")

        _, _, _, _, ncmds, _, _, _ = struct.unpack_from("<IiiIIIII", data, 0)
        offset = 32
        sections: list[Section] = []

        for _ in range(ncmds):
            cmd, cmdsize = struct.unpack_from("<II", data, offset)
            if cmd == self.LC_SEGMENT_64:
                segname_raw = struct.unpack_from("<16s", data, offset + 8)[0]
                segname = segname_raw.split(b"\x00", 1)[0].decode("ascii", "replace")
                nsects = struct.unpack_from("<I", data, offset + 64)[0]
                sect_offset = offset + 72
                for _ in range(nsects):
                    sectname_raw, sec_segname_raw = struct.unpack_from("<16s16s", data, sect_offset)
                    sectname = sectname_raw.split(b"\x00", 1)[0].decode("ascii", "replace")
                    sec_segname = sec_segname_raw.split(b"\x00", 1)[0].decode("ascii", "replace")
                    addr, size, fileoff = struct.unpack_from("<QQI", data, sect_offset + 32)
                    sections.append(
                        Section(
                            segname=sec_segname or segname,
                            sectname=sectname,
                            addr=addr,
                            size=size,
                            offset=fileoff,
                        )
                    )
                    sect_offset += 80
            offset += cmdsize

        return sections

    def section(self, segname: str, sectname: str) -> Section:
        for section in self.sections:
            if section.segname == segname and section.sectname == sectname:
                return section
        raise KeyError(f"missing section {segname},{sectname}")

    def vm_to_file_offset(self, vmaddr: int) -> int:
        for section in self.sections:
            if section.addr <= vmaddr < section.addr + section.size:
                return section.offset + (vmaddr - section.addr)
        raise KeyError(f"vmaddr {vmaddr:#x} not in any section")

    def read_c_string(self, vmaddr: int) -> str | None:
        try:
            file_offset = self.vm_to_file_offset(vmaddr)
        except KeyError:
            return None
        end = self.data.find(b"\x00", file_offset)
        if end == -1:
            return None
        raw = self.data[file_offset:end]
        try:
            return raw.decode("utf-8", "replace")
        except UnicodeDecodeError:
            return None

    def read_double(self, vmaddr: int) -> float:
        file_offset = self.vm_to_file_offset(vmaddr)
        return struct.unpack_from("<d", self.data, file_offset)[0]


@dataclass(frozen=True)
class MotionTypeInfo:
    name: str
    kind: int
    fields: list[str]


def extract_motion_type_fields(binary: MachOBinary) -> list[MotionTypeInfo]:
    reflstr = binary.section("__TEXT", "__swift5_reflstr")
    fieldmd = binary.section("__TEXT", "__swift5_fieldmd")
    types = binary.section("__TEXT", "__swift5_types")
    const_sections = [
        binary.section("__TEXT", "__const"),
        binary.section("__TEXT", "__constg_swiftt"),
        binary.section("__TEXT", "__swift5_typeref"),
        reflstr,
        fieldmd,
        types,
    ]

    def cstr(vmaddr: int) -> str | None:
        for section in const_sections:
            if section.addr <= vmaddr < section.addr + section.size:
                file_offset = section.offset + (vmaddr - section.addr)
                end = binary.data.find(b"\x00", file_offset)
                if end == -1:
                    return None
                return binary.data[file_offset:end].decode("utf-8", "replace")
        return None

    field_map: dict[int, tuple[int, list[str]]] = {}
    pos = fieldmd.offset
    end = fieldmd.offset + fieldmd.size
    while pos < end:
        _, _, kind, record_size, field_count = struct.unpack_from("<iiHHI", binary.data, pos)
        desc_vm = fieldmd.addr + (pos - fieldmd.offset)
        field_pos = pos + 16
        fields: list[str] = []
        for _ in range(field_count):
            _, _, field_rel = struct.unpack_from("<Iii", binary.data, field_pos)
            field_name = None
            if field_rel:
                field_name = cstr((fieldmd.addr + (field_pos - fieldmd.offset)) + 8 + field_rel)
            fields.append(field_name or "<unknown>")
            field_pos += record_size
        field_map[desc_vm] = (kind, fields)
        pos = field_pos

    interesting: list[MotionTypeInfo] = []
    seen: set[tuple[str, int]] = set()
    for entry_off in range(0, types.size, 4):
        entry_vm = types.addr + entry_off
        rel = struct.unpack_from("<i", binary.data, types.offset + entry_off)[0]
        desc_vm = entry_vm + rel
        try:
            desc_file = binary.vm_to_file_offset(desc_vm)
        except KeyError:
            continue
        _, _, name_rel, _, field_rel = struct.unpack_from("<IIiii", binary.data, desc_file)
        name = None
        for base in (desc_vm + 8, desc_vm + 12, desc_vm):
            value = cstr(base + name_rel)
            if value and any(ch.isalpha() for ch in value):
                name = value
                break
        if not name:
            continue
        field_desc_vm = desc_vm + 16 + field_rel if field_rel else None
        if field_desc_vm not in field_map:
            continue
        kind, fields = field_map[field_desc_vm]
        needles = (
            "Cursor",
            "Bezier",
            "Spring",
            "Animation",
            "VelocityVerlet",
            "Configuration",
            "DisplayLink",
            "CloseEnough",
        )
        if not any(needle in name for needle in needles):
            continue
        key = (name, field_desc_vm)
        if key in seen:
            continue
        seen.add(key)
        interesting.append(MotionTypeInfo(name=name, kind=kind, fields=fields))

    return sorted(interesting, key=lambda item: item.name)


EXTRACTED_DOUBLE_CONSTANTS = {
    "distance_scale_primary": 0x100865928,
    "direct_span_scale": 0x100865910,
    "side_bias_scale": 0x100865930,
    "distance_scale_secondary": 0x100865938,
    "distance_scale_tertiary": 0x100865940,
    "minimum_step_distance": 0x100865948,
    "pi": 0x100865950,
    "negative_two_pi": 0x100865958,
    "negative_pi": 0x100865960,
    "positive_two_pi": 0x100865968,
    "nearly_negative_one": 0x100865970,
    "epsilon_01": 0x100865978,
    "score_length_weight": 0x100860C10,
    "score_angle_energy_weight": 0x100860C18,
    "score_max_angle_weight": 0x100860C20,
    "score_total_turn_weight": 0x100860C28,
    "score_in_bounds_factor": 0x100860C30,
    "score_secondary_in_bounds_factor": 0x100860C38,
    "score_shape_weight_a": 0x100860C40,
    "score_shape_weight_b": 0x100860C48,
    "score_shape_anchor": 0x100860C50,
}


def extract_named_constants(binary: MachOBinary) -> dict[str, float]:
    return {name: binary.read_double(vmaddr) for name, vmaddr in EXTRACTED_DOUBLE_CONSTANTS.items()}


CONFIRMED_DISASSEMBLY_CONSTANTS = {
    "normalization_epsilon": 0.001,
    "candidate_handle_min": 50.0,
    "candidate_handle_max": 520.0,
    "candidate_arc_min": 38.0,
    "candidate_arc_max": 440.0,
    "score_out_of_bounds_penalty": 45.0,
    "score_excess_length_weight": 320.0,
    "score_angle_energy_weight": 140.0,
    "score_max_angle_weight": 180.0,
    "score_total_turn_weight": 18.0,
}

CONFIRMED_CURSOR_TIMING_CONSTANTS = {
    "close_enough_progress_threshold": 1.0,
    "close_enough_distance_threshold": 0.01,
    "cursor_path_spring_response": 1.4,
    "cursor_path_spring_damping_fraction": 0.9,
    "velocity_verlet_dt": 1.0 / 240.0,
    "velocity_verlet_idle_velocity_threshold": 28800.0,
}

CONFIRMED_TIMING_TYPE_RELATIONSHIPS = {
    "ComputerUseCursor.CloseEnoughConfiguration": {
        "kind": "struct",
        "fields": ["progressThreshold", "distanceThreshold"],
    },
    "ComputerUseCursor.CursorNextInteractionTiming": {
        "kind": "enum",
        "cases": ["closeEnough", "finished"],
    },
    "ComputerUseCursor.Window": {
        "kind": "class",
        "fields": [
            "style",
            "appMonitor",
            "wantsToBeVisible",
            "cursorMotionProgressAnimation",
            "cursorMotionNextInteractionTimingHandler",
            "cursorMotionCompletionHandler",
            "cursorMotionDidSatisfyNextInteractionTiming",
            "currentInterpolatedOrigin",
            "useOverlayWindowLevel",
            "correspondingWindowID",
        ],
    },
    "Animation.SpringParameters": {
        "kind": "struct",
        "fields": ["response", "dampingFraction"],
    },
    "Animation.AnimationDescriptor": {
        "kind": "enum",
        "cases": ["bezier", "spring"],
    },
    "Animation.Transaction": {
        "kind": "struct",
        "fields": ["priority", "delay", "completion", "id", "driverSource", "descriptor"],
    },
    "Animation.VelocityVerletSimulation.Configuration": {
        "kind": "struct",
        "fields": ["response", "stiffness", "drag", "dt", "idleVelocityThreshold"],
    },
}

CONFIRMED_TIMING_PIPELINE = {
    "window_animation_state_slots": {
        "field_order_matches_binary_slot_writes": True,
        "fields_written_in_cursor_path_animation_setup": [
            "cursorMotionProgressAnimation",
            "cursorMotionNextInteractionTimingHandler",
            "cursorMotionCompletionHandler",
            "cursorMotionDidSatisfyNextInteractionTiming",
        ],
    },
    "animation_stack": [
        "ComputerUseCursor.CloseEnoughConfiguration(progressThreshold=1.0, distanceThreshold=0.01)",
        "ComputerUseCursor.CursorNextInteractionTiming.closeEnough(...)",
        "Animation.SpringParameters(response=1.4, dampingFraction=0.9)",
        "Animation.AnimationDescriptor.spring(...)",
        "Animation.SpringAnimation",
        "Animation.VelocityVerletSimulation.Configuration",
    ],
    "binary_functions": {
        "close_enough_metadata_accessor": "0x10005ed78",
        "next_interaction_timing_metadata_accessor": "0x10005ed88",
        "spring_parameters_metadata_accessor": "0x100587990",
        "animation_descriptor_metadata_accessor": "0x100596470",
        "spring_animation_metadata_accessor": "0x1005768c4",
        "spring_animation_allocating_init_wrapper": "0x100576790",
        "spring_animation_designated_init": "0x10057652c",
        "spring_animation_frame_update": "0x1005761bc",
        "spring_animation_value_copy_helper": "0x1005730bc",
        "spring_animation_target_copy_helper": "0x100573390",
        "velocity_verlet_configuration_init": "0x100592f20",
        "velocity_verlet_configuration_completion": "0x100593cfc",
        "velocity_verlet_advance_to_time": "0x100593404",
        "velocity_verlet_advance_one_step": "0x100594110",
        "spring_animation_finished_predicate": "0x1005934b0",
        "transaction_metadata_accessor": "0x1005967fc",
    },
    "spring_parameter_normalization_helper": {
        "function": "0x1005879a4",
        "input_name_in_binary_not_recovered": True,
        "confirmed_piecewise_mapping": "if x <= -1 -> +inf; else if x < 0 -> 1 / (1 + x); else if x == 0 -> 0; else -> 1 - min(x, 1)",
        "note": "This helper lives in the Animation.SpringParameters area; the cursor path animation uses direct response/dampingFraction constants and does not need this remap.",
    },
    "velocity_verlet_completion_status": {
        "two_pi_constant_used": True,
        "stiffness_and_drag_fields_exist": True,
        "exact_numeric_formula_transcription_complete": True,
    },
    "velocity_verlet_exact_math": {
        "stiffness_formula": "stiffness = min(response > 0 ? (2π / response)^2 : +inf, 28800)",
        "drag_formula": "drag = 2 * dampingFraction * sqrt(stiffness)",
        "stale_time_clamp": "if targetTime - time > 1.0, set time = targetTime - 1/60 before stepping",
        "step_sequence": [
            "velocityHalf = velocity + force * (dt / 2)",
            "current = current + velocityHalf * dt",
            "force = stiffness * (target - current) + (-drag) * velocityHalf",
            "velocity = velocityHalf + force * (dt / 2)",
        ],
    },
    "spring_animation_update_and_finish": {
        "frame_update_function": "0x1005761bc",
        "confirmed_behavior": [
            "copy a current-value-like buffer from hidden self offset 0x68",
            "copy a target-value-like buffer from hidden self offset 0x70",
            "advance the spring simulation via 0x100593404",
            "run 0x1005934b0 as the finished predicate",
            "return optional nil when finished, otherwise return some(updatedValue)",
        ],
        "finish_predicate_function": "0x1005934b0",
        "finish_predicate_gates": {
            "threshold_square_gate": "load two hidden-self scalar slots, take Swift.max(slotA, slotB), and require max(slotA, slotB) <= threshold^2 to continue",
            "exact_zero_gate": "build a float literal 0.01, run SIMD scalar loops, then accept only when a difference-derived scalar A is neither > 0 nor < 0",
        },
        "field_mapping_notes": {
            "copy_helper_offsets": {
                "0x1005730bc": "reads hidden self offset 0x68",
                "0x100573390": "reads hidden self offset 0x70",
            },
            "threshold_field_inference": "the metadata field loaded via +0x30 in 0x1005934b0 is very likely idleVelocityThreshold; this is inferred from adjacent layout and threshold-squared usage, not a direct symbol name",
            "value_target_field_inference": "the 0x68/0x70 slots are very likely InterpolatableAnimation._value / _targetValue; this mapping is inferred from class field metadata plus offset adjacency, not directly named in the code",
        },
    },
    "shared_helper_reuse": {
        "system_settings_accessory_transition_geometry_style": {
            "spring_response": 0.72,
            "spring_damping_fraction": 1.0,
            "note": "This is a separate bundled-binary caller that reuses part of the same spring initialization chain.",
        }
    },
}


def build_model_constants(binary: MachOBinary) -> dict[str, float]:
    model_constants = extract_named_constants(binary)
    model_constants.update(CONFIRMED_DISASSEMBLY_CONSTANTS)
    return model_constants


def extract_candidate_tables(binary: MachOBinary) -> dict[str, list[float]]:
    table_a_vm = 0x10098B988
    table_b_vm = 0x10098B9C0
    table_a = [binary.read_double(table_a_vm + 0x20 + (index * 8)) for index in range(3)]
    table_b = [binary.read_double(table_b_vm + 0x20 + (index * 8)) for index in range(3)]
    return {"table_a": table_a, "table_b": table_b}


@dataclass(frozen=True)
class Vec2:
    x: float
    y: float

    def __add__(self, other: "Vec2") -> "Vec2":
        return Vec2(self.x + other.x, self.y + other.y)

    def __sub__(self, other: "Vec2") -> "Vec2":
        return Vec2(self.x - other.x, self.y - other.y)

    def scale(self, factor: float) -> "Vec2":
        return Vec2(self.x * factor, self.y * factor)

    def length(self) -> float:
        return math.hypot(self.x, self.y)

    def normalized(self) -> "Vec2":
        length = self.length()
        if length <= 1e-9:
            return Vec2(1.0, 0.0)
        return Vec2(self.x / length, self.y / length)

    def perpendicular(self) -> "Vec2":
        return Vec2(-self.y, self.x)

    def to_list(self) -> list[float]:
        return [self.x, self.y]


@dataclass(frozen=True)
class Bounds:
    min_x: float
    min_y: float
    max_x: float
    max_y: float

    def contains(self, point: Vec2, padding: float = 0.0) -> bool:
        return (
            (self.min_x - padding) <= point.x <= (self.max_x + padding)
            and (self.min_y - padding) <= point.y <= (self.max_y + padding)
        )


@dataclass(frozen=True)
class CubicSegment:
    end: Vec2
    control1: Vec2
    control2: Vec2


@dataclass(frozen=True)
class SamplePoint:
    progress: float
    point: Vec2
    tangent: Vec2
    speed_units_per_progress: float

    def to_dict(self) -> dict[str, object]:
        return {
            "progress": self.progress,
            "point": self.point.to_list(),
            "tangent": self.tangent.to_list(),
            "speed_units_per_progress": self.speed_units_per_progress,
        }


@dataclass(frozen=True)
class CursorMotionMeasurement:
    length: float
    angle_change_energy: float
    max_angle_change: float
    total_turn: float
    stays_in_bounds: bool

    def to_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class CandidateScoreComponents:
    excess_length_ratio: float
    excess_length_cost: float
    angle_energy_cost: float
    max_angle_cost: float
    total_turn_cost: float
    out_of_bounds_cost: float
    total_score: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class ScalarSpringConfiguration:
    response: float
    damping_fraction: float
    stiffness: float
    drag: float
    dt: float
    close_enough_progress_threshold: float
    close_enough_distance_threshold: float
    idle_velocity_threshold: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class ScalarVelocityVerletState:
    time: float
    velocity: float
    force: float

    def to_dict(self) -> dict[str, float]:
        return asdict(self)


@dataclass(frozen=True)
class TimedCursorSample:
    step: int
    time: float
    progress: float
    point: Vec2
    spring_velocity: float
    spring_force: float
    geometric_speed_units_per_second: float

    def to_dict(self) -> dict[str, object]:
        return {
            "step": self.step,
            "time": self.time,
            "progress": self.progress,
            "point": self.point.to_list(),
            "spring_velocity": self.spring_velocity,
            "spring_force": self.spring_force,
            "geometric_speed_units_per_second": self.geometric_speed_units_per_second,
        }


@dataclass(frozen=True)
class CursorMotionPath:
    start: Vec2
    end: Vec2
    start_control: Vec2 | None = None
    arc: Vec2 | None = None
    arc_in: Vec2 | None = None
    arc_out: Vec2 | None = None
    end_control: Vec2 | None = None
    segments: tuple[CubicSegment, ...] = ()

    def sample(self, progress: float) -> tuple[Vec2, Vec2]:
        if not self.segments:
            return self.start, Vec2(1.0, 0.0)

        clamped = min(max(progress, 0.0), 1.0)
        segment_count = len(self.segments)
        if clamped >= 1.0:
            segment_index = segment_count - 1
            local_t = 1.0
        else:
            scaled = clamped * segment_count
            segment_index = min(int(scaled), segment_count - 1)
            local_t = scaled - segment_index

        segment = self.segments[segment_index]
        start = self.start if segment_index == 0 else self.segments[segment_index - 1].end
        point = _sample_cubic(start, segment.control1, segment.control2, segment.end, local_t)
        tangent = _sample_cubic_tangent(start, segment.control1, segment.control2, segment.end, local_t).normalized()
        return point, tangent

    def sample_points(self, count: int) -> list[SamplePoint]:
        samples: list[SamplePoint] = []
        previous_point: Vec2 | None = None
        for index in range(count):
            progress = index / max(count - 1, 1)
            point, tangent = self.sample(progress)
            speed = 0.0 if previous_point is None else (point - previous_point).length()
            samples.append(
                SamplePoint(
                    progress=progress,
                    point=point,
                    tangent=tangent,
                    speed_units_per_progress=speed,
                )
            )
            previous_point = point
        return samples

    def measure(self, bounds: Bounds | None, min_step_distance: float = 0.01, samples_per_segment: int = 24) -> CursorMotionMeasurement:
        total_length = 0.0
        angle_change_energy = 0.0
        max_angle_change = 0.0
        total_turn = 0.0
        stays_in_bounds = True
        previous_point = self.start
        previous_angle: float | None = None

        if bounds is not None:
            stays_in_bounds = bounds.contains(self.start, padding=20.0)

        total_steps = max(len(self.segments) * samples_per_segment, 1)
        for step in range(1, total_steps + 1):
            progress = step / total_steps
            point, _ = self.sample(progress)
            delta = point - previous_point
            step_length = delta.length()

            if bounds is not None and stays_in_bounds:
                stays_in_bounds = bounds.contains(point, padding=20.0)

            if step_length > min_step_distance:
                angle = math.atan2(delta.y, delta.x)
                total_length += step_length

                if previous_angle is not None:
                    angle_delta = angle - previous_angle
                    while angle_delta > math.pi:
                        angle_delta -= math.tau
                    while angle_delta < -math.pi:
                        angle_delta += math.tau
                    angle_change_energy += angle_delta * angle_delta
                    absolute_delta = abs(angle_delta)
                    max_angle_change = max(max_angle_change, absolute_delta)
                    total_turn += absolute_delta

                previous_angle = angle
                previous_point = point

        return CursorMotionMeasurement(
            length=total_length,
            angle_change_energy=angle_change_energy,
            max_angle_change=max_angle_change,
            total_turn=total_turn,
            stays_in_bounds=stays_in_bounds,
        )


@dataclass(frozen=True)
class CandidatePath:
    identifier: str
    kind: str
    side: int
    table_a_scale: float | None
    table_b_scale: float | None
    score: float
    score_components: CandidateScoreComponents
    measurement: CursorMotionMeasurement
    path: CursorMotionPath

    def summary_dict(self) -> dict[str, object]:
        return {
            "identifier": self.identifier,
            "kind": self.kind,
            "side": self.side,
            "table_a_scale": self.table_a_scale,
            "table_b_scale": self.table_b_scale,
            "score": self.score,
            "score_components": self.score_components.to_dict(),
            "measurement": self.measurement.to_dict(),
        }

    def to_dict(self, sample_count: int, include_samples: bool = True) -> dict[str, object]:
        return {
            "identifier": self.identifier,
            "kind": self.kind,
            "side": self.side,
            "table_a_scale": self.table_a_scale,
            "table_b_scale": self.table_b_scale,
            "score": self.score,
            "score_components": self.score_components.to_dict(),
            "measurement": self.measurement.to_dict(),
            "path": {
                "start": self.path.start.to_list(),
                "end": self.path.end.to_list(),
                "start_control": self.path.start_control.to_list() if self.path.start_control else None,
                "arc": self.path.arc.to_list() if self.path.arc else None,
                "arc_in": self.path.arc_in.to_list() if self.path.arc_in else None,
                "arc_out": self.path.arc_out.to_list() if self.path.arc_out else None,
                "end_control": self.path.end_control.to_list() if self.path.end_control else None,
                "segments": [
                    {
                        "end": segment.end.to_list(),
                        "control1": segment.control1.to_list(),
                        "control2": segment.control2.to_list(),
                    }
                    for segment in self.path.segments
                ],
            },
            "samples": [sample.to_dict() for sample in self.path.sample_points(sample_count)] if include_samples else [],
        }


@dataclass(frozen=True)
class BinaryGuidedPathOverrides:
    start_extent_scale: float = 1.0
    end_extent_scale: float = 1.0
    arc_size_scale: float = 1.0
    arc_flow_scale: float = 1.0


def _sample_cubic(start: Vec2, control1: Vec2, control2: Vec2, end: Vec2, t: float) -> Vec2:
    omt = 1.0 - t
    omt2 = omt * omt
    t2 = t * t
    return Vec2(
        x=(omt2 * omt * start.x)
        + (3.0 * omt2 * t * control1.x)
        + (3.0 * omt * t2 * control2.x)
        + (t2 * t * end.x),
        y=(omt2 * omt * start.y)
        + (3.0 * omt2 * t * control1.y)
        + (3.0 * omt * t2 * control2.y)
        + (t2 * t * end.y),
    )


def _sample_cubic_tangent(start: Vec2, control1: Vec2, control2: Vec2, end: Vec2, t: float) -> Vec2:
    omt = 1.0 - t
    return Vec2(
        x=(3.0 * omt * omt * (control1.x - start.x))
        + (6.0 * omt * t * (control2.x - control1.x))
        + (3.0 * t * t * (end.x - control2.x)),
        y=(3.0 * omt * omt * (control1.y - start.y))
        + (6.0 * omt * t * (control2.y - control1.y))
        + (3.0 * t * t * (end.y - control2.y)),
    )


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def signed_angle(lhs: Vec2, rhs: Vec2) -> float:
    return math.atan2((lhs.x * rhs.y) - (lhs.y * rhs.x), (lhs.x * rhs.x) + (lhs.y * rhs.y))


def build_scalar_spring_configuration() -> ScalarSpringConfiguration:
    response = CONFIRMED_CURSOR_TIMING_CONSTANTS["cursor_path_spring_response"]
    damping_fraction = CONFIRMED_CURSOR_TIMING_CONSTANTS["cursor_path_spring_damping_fraction"]
    return build_scalar_spring_configuration_for(
        response=response,
        damping_fraction=damping_fraction,
    )


def build_scalar_spring_configuration_for(
    response: float,
    damping_fraction: float,
) -> ScalarSpringConfiguration:
    dt = CONFIRMED_CURSOR_TIMING_CONSTANTS["velocity_verlet_dt"]
    idle_velocity_threshold = CONFIRMED_CURSOR_TIMING_CONSTANTS["velocity_verlet_idle_velocity_threshold"]

    # 0x100593cfc computes stiffness from the scalar spring response with:
    # raw = (2π / response)^2 if response > 0, otherwise +inf
    raw_stiffness = math.inf if response <= 0.0 else (math.tau / response) ** 2
    stiffness = min(raw_stiffness, idle_velocity_threshold)

    # 0x100593f18 then computes drag from the already-clamped stiffness as
    # 2 * dampingFraction * sqrt(stiffness).
    drag = 2.0 * damping_fraction * math.sqrt(stiffness)

    return ScalarSpringConfiguration(
        response=response,
        damping_fraction=damping_fraction,
        stiffness=stiffness,
        drag=drag,
        dt=dt,
        close_enough_progress_threshold=CONFIRMED_CURSOR_TIMING_CONSTANTS["close_enough_progress_threshold"],
        close_enough_distance_threshold=CONFIRMED_CURSOR_TIMING_CONSTANTS["close_enough_distance_threshold"],
        idle_velocity_threshold=idle_velocity_threshold,
    )


def advance_scalar_velocity_verlet(
    current: float,
    target: float,
    state: ScalarVelocityVerletState,
    config: ScalarSpringConfiguration,
) -> tuple[float, ScalarVelocityVerletState]:
    half_dt = config.dt * 0.5

    # 0x100594948..0x100594b04
    velocity_half = state.velocity + (state.force * half_dt)
    # 0x100594c4c..0x100594e8c
    current = current + (velocity_half * config.dt)
    # 0x100594ecc..0x1005954f4
    force = (config.stiffness * (target - current)) + ((-config.drag) * velocity_half)
    # 0x1005955f0..0x100595858
    velocity = velocity_half + (force * half_dt)

    return current, ScalarVelocityVerletState(
        time=state.time + config.dt,
        velocity=velocity,
        force=force,
    )


def advance_scalar_velocity_verlet_to_time(
    current: float,
    target: float,
    state: ScalarVelocityVerletState,
    config: ScalarSpringConfiguration,
    target_time: float,
) -> tuple[float, ScalarVelocityVerletState]:
    # 0x100593404 limits excessively stale simulation time to targetTime - 1/60.
    if (target_time - state.time) > 1.0:
        state = ScalarVelocityVerletState(
            time=target_time - (1.0 / 60.0),
            velocity=state.velocity,
            force=state.force,
        )

    while state.time < target_time:
        current, state = advance_scalar_velocity_verlet(
            current=current,
            target=target,
            state=state,
            config=config,
        )

    return current, state


def build_timed_cursor_timeline(
    path: CursorMotionPath,
    config: ScalarSpringConfiguration | None = None,
    report_every_steps: int = 4,
    max_duration_seconds: float = 2.0,
) -> dict[str, object]:
    config = config or build_scalar_spring_configuration()
    current = 0.0
    target = 1.0
    state = ScalarVelocityVerletState(time=0.0, velocity=0.0, force=0.0)
    samples: list[TimedCursorSample] = []
    previous_point: Vec2 | None = None
    close_enough_first_time: float | None = None
    close_enough_first_step: int | None = None
    raw_progress_first_ge_target_time: float | None = None
    raw_progress_first_ge_target_step: int | None = None
    first_endpoint_lock_time: float | None = None
    first_endpoint_lock_step: int | None = None
    step_count = int(max_duration_seconds / config.dt)

    start_point, _ = path.sample(current)
    samples.append(
        TimedCursorSample(
            step=0,
            time=0.0,
            progress=current,
            point=start_point,
            spring_velocity=state.velocity,
            spring_force=state.force,
            geometric_speed_units_per_second=0.0,
        )
    )
    previous_point = start_point

    for step in range(1, step_count + 1):
        target_time = step * config.dt
        current, state = advance_scalar_velocity_verlet_to_time(
            current=current,
            target=target,
            state=state,
            config=config,
            target_time=target_time,
        )
        point, _ = path.sample(current)
        geometric_speed = 0.0 if previous_point is None else (point - previous_point).length() / config.dt
        previous_point = point

        if raw_progress_first_ge_target_time is None and current >= target:
            raw_progress_first_ge_target_time = state.time
            raw_progress_first_ge_target_step = step

        if first_endpoint_lock_time is None and current >= target and point == path.end:
            first_endpoint_lock_time = state.time
            first_endpoint_lock_step = step

        if (
            close_enough_first_time is None
            and current >= config.close_enough_progress_threshold
            and abs(target - current) <= config.close_enough_distance_threshold
        ):
            close_enough_first_time = state.time
            close_enough_first_step = step

        should_record = (step % report_every_steps) == 0 or step == step_count
        if should_record:
            samples.append(
                TimedCursorSample(
                    step=step,
                    time=state.time,
                    progress=current,
                    point=point,
                    spring_velocity=state.velocity,
                    spring_force=state.force,
                    geometric_speed_units_per_second=geometric_speed,
                )
            )

    return {
        "spring_configuration": config.to_dict(),
        "simulation_state_at_end": state.to_dict(),
        "binary_confirmed_step_sequence": [
            "velocityHalf = velocity + force * (dt / 2)",
            "current = current + velocityHalf * dt",
            "force = stiffness * (target - current) + (-drag) * velocityHalf",
            "velocity = velocityHalf + force * (dt / 2)",
        ],
        "internal_step_hz": round(1.0 / config.dt),
        "reported_sample_hz": round(1.0 / (config.dt * report_every_steps)),
        "reported_sample_stride_steps": report_every_steps,
        "raw_progress_first_ge_target_time": raw_progress_first_ge_target_time,
        "raw_progress_first_ge_target_step": raw_progress_first_ge_target_step,
        "first_endpoint_lock_time": first_endpoint_lock_time,
        "first_endpoint_lock_step": first_endpoint_lock_step,
        "close_enough_first_time": close_enough_first_time,
        "close_enough_first_step": close_enough_first_step,
        "endpoint_lock_inference_note": "CursorMotionPath.sample(progress) is binary-confirmed to clamp progress into [0, 1], so the visible point becomes the exact path endpoint once raw spring progress first reaches 1.0. The linkage from that visible endpoint lock to SpringAnimation's finished optional-return path is still an inference from multiple confirmed pieces.",
        "samples": [sample.to_dict() for sample in samples],
    }


def _binary_piecewise_primary_extents(distance: float, constants: dict[str, float], guide: Vec2) -> tuple[float, float]:
    if not (guide.x < 0.0 < guide.y):
        raise ValueError("the current binary lift assumes the bundled guide vector has negative x and positive y")

    primary = distance * constants["distance_scale_primary"]
    direct = distance * constants["direct_span_scale"]
    secondary = distance * 0.15
    low_cutoff = 48.0
    high_cutoff = 640.0

    # This is the sign-specialized lift of 0x10005fe84..0x10006013c for the
    # bundled guide vector (-0.6946, +0.7193). The binary's branch tree reduces
    # to four piecewise regions under that fixed sign pattern.
    if primary < low_cutoff:
        return low_cutoff, low_cutoff
    if primary < high_cutoff:
        return primary, direct
    if secondary < high_cutoff:
        return high_cutoff, low_cutoff
    return high_cutoff, high_cutoff


def _binary_piecewise_handle_extent(distance: float, constants: dict[str, float]) -> float:
    raw = distance * constants["distance_scale_secondary"]
    if raw < 50.0:
        return 50.0
    if raw < 640.0:
        return raw
    return 520.0


def _clip_positive_ray(origin: Vec2, direction: Vec2, bounds: Bounds | None) -> float:
    if bounds is None:
        return math.inf

    limit = math.inf
    if direction.x > 0.0:
        limit = min(limit, (bounds.max_x - origin.x) / direction.x)
    elif direction.x < 0.0:
        limit = min(limit, (bounds.min_x - origin.x) / direction.x)

    if direction.y > 0.0:
        limit = min(limit, (bounds.max_y - origin.y) / direction.y)
    elif direction.y < 0.0:
        limit = min(limit, (bounds.min_y - origin.y) / direction.y)

    return max(limit, 0.0)


def _normalized_or_default(vector: Vec2, minimum_length: float, constants: dict[str, float]) -> Vec2:
    length = vector.length()
    if length < minimum_length or length < constants["normalization_epsilon"]:
        return Vec2(1.0, 0.0)
    return vector.scale(1.0 / length)


class BinaryGuidedPathGenerator:
    def __init__(self, constants: dict[str, float], tables: dict[str, list[float]]):
        self.constants = constants
        self.tables = tables
        self.guide_local = Vec2(-0.6946583704589973, 0.7193398003386512)

    def build_candidates(
        self,
        start: Vec2,
        end: Vec2,
        bounds: Bounds | None,
        overrides: BinaryGuidedPathOverrides | None = None,
    ) -> list[CandidatePath]:
        overrides = overrides or BinaryGuidedPathOverrides()
        delta = end - start
        distance = max(delta.length(), self.constants["normalization_epsilon"])
        direction = delta.normalized()
        local_normal = direction.perpendicular()
        guide = direction.scale(self.guide_local.x) + local_normal.scale(self.guide_local.y)
        reverse_guide = guide.scale(-1.0)

        start_extent_pre, end_extent_pre = _binary_piecewise_primary_extents(
            distance=distance,
            constants=self.constants,
            guide=guide,
        )
        start_extent = min(start_extent_pre * overrides.start_extent_scale, _clip_positive_ray(start, guide, bounds))
        end_extent = min(end_extent_pre * overrides.end_extent_scale, _clip_positive_ray(end, reverse_guide, bounds))

        start_extent_scaled = min(
            max(start_extent * self.constants["side_bias_scale"], 0.0),
            _clip_positive_ray(start, guide, bounds),
        )
        end_extent_scaled = min(
            max(end_extent * self.constants["side_bias_scale"], 0.0),
            _clip_positive_ray(end, reverse_guide, bounds),
        )

        full_start_control = start + guide.scale(start_extent)
        full_end_control = end - guide.scale(end_extent)
        scaled_start_control = start + guide.scale(start_extent_scaled)
        scaled_end_control = end - guide.scale(end_extent_scaled)

        raw_handle_extent = _binary_piecewise_handle_extent(distance, self.constants) * overrides.arc_size_scale
        raw_arc_extent = clamp(
            distance * self.constants["distance_scale_tertiary"] * overrides.arc_size_scale,
            self.constants["candidate_arc_min"],
            self.constants["candidate_arc_max"],
        )

        midpoint = Vec2((start.x + end.x) * 0.5, (start.y + end.y) * 0.5)
        signed_normal = local_normal
        cross = (guide.y * direction.x) - (guide.x * direction.y)
        if cross < 0.0:
            signed_normal = signed_normal.scale(-1.0)
        arc_anchor_bias = guide.scale(start_extent * self.constants["side_bias_scale"] * overrides.arc_flow_scale)
        forward_unit = _normalized_or_default(
            direction.scale(distance) + signed_normal.scale(raw_arc_extent),
            minimum_length=raw_handle_extent,
            constants=self.constants,
        )

        candidates: list[CandidatePath] = []
        candidates.append(
            self._make_candidate(
                identifier="base-full-guide",
                kind="base",
                side=0,
                table_a_scale=None,
                table_b_scale=None,
                path=CursorMotionPath(
                    start=start,
                    end=end,
                    start_control=full_start_control,
                    end_control=full_end_control,
                    segments=(CubicSegment(end=end, control1=full_start_control, control2=full_end_control),),
                ),
                bounds=bounds,
                distance=distance,
            )
        )
        candidates.append(
            self._make_candidate(
                identifier="base-scaled-guide",
                kind="base",
                side=0,
                table_a_scale=None,
                table_b_scale=None,
                path=CursorMotionPath(
                    start=start,
                    end=end,
                    start_control=scaled_start_control,
                    end_control=scaled_end_control,
                    segments=(CubicSegment(end=end, control1=scaled_start_control, control2=scaled_end_control),),
                ),
                bounds=bounds,
                distance=distance,
            )
        )

        for outer_scale in self.tables["table_a"]:
            anchor_offset = signed_normal.scale(raw_handle_extent * outer_scale)
            for inner_scale in self.tables["table_b"]:
                tangent_span = forward_unit.scale(raw_arc_extent * inner_scale)

                for side, anchor in (
                    (1, midpoint + arc_anchor_bias + anchor_offset),
                    (-1, midpoint + arc_anchor_bias - anchor_offset),
                ):
                    arc_in = anchor - tangent_span
                    arc_out = anchor + tangent_span
                    path = CursorMotionPath(
                        start=start,
                        end=end,
                        start_control=full_start_control,
                        arc=anchor,
                        arc_in=arc_in,
                        arc_out=arc_out,
                        end_control=full_end_control,
                        segments=(
                            CubicSegment(end=anchor, control1=full_start_control, control2=arc_in),
                            CubicSegment(end=end, control1=arc_out, control2=full_end_control),
                        ),
                    )
                    candidates.append(
                        self._make_candidate(
                            identifier=f"a{outer_scale:.2f}-b{inner_scale:.2f}-{'positive' if side > 0 else 'negative'}",
                            kind="arched",
                            side=side,
                            table_a_scale=outer_scale,
                            table_b_scale=inner_scale,
                            path=path,
                            bounds=bounds,
                            distance=distance,
                        )
                    )

        return candidates

    def choose_candidate(self, candidates: list[CandidatePath]) -> tuple[CandidatePath | None, str]:
        if not candidates:
            return None, "empty"

        in_bounds_candidates = [candidate for candidate in candidates if candidate.measurement.stays_in_bounds]
        pool = in_bounds_candidates if in_bounds_candidates else candidates
        policy = "prefer_in_bounds_then_lowest_score" if in_bounds_candidates else "lowest_score"
        return min(pool, key=lambda item: item.score), policy

    def _score_candidate(
        self,
        distance: float,
        measurement: CursorMotionMeasurement,
    ) -> CandidateScoreComponents:
        excess_length_ratio = max((measurement.length / max(distance, 1.0)) - 1.0, 0.0)
        excess_length_cost = excess_length_ratio * self.constants["score_excess_length_weight"]
        angle_energy_cost = measurement.angle_change_energy * self.constants["score_angle_energy_weight"]
        max_angle_cost = measurement.max_angle_change * self.constants["score_max_angle_weight"]
        total_turn_cost = measurement.total_turn * self.constants["score_total_turn_weight"]
        out_of_bounds_cost = 0.0 if measurement.stays_in_bounds else self.constants["score_out_of_bounds_penalty"]
        total_score = (
            excess_length_cost
            + angle_energy_cost
            + max_angle_cost
            + total_turn_cost
            + out_of_bounds_cost
        )
        return CandidateScoreComponents(
            excess_length_ratio=excess_length_ratio,
            excess_length_cost=excess_length_cost,
            angle_energy_cost=angle_energy_cost,
            max_angle_cost=max_angle_cost,
            total_turn_cost=total_turn_cost,
            out_of_bounds_cost=out_of_bounds_cost,
            total_score=total_score,
        )

    def _make_candidate(
        self,
        identifier: str,
        kind: str,
        side: int,
        table_a_scale: float | None,
        table_b_scale: float | None,
        path: CursorMotionPath,
        bounds: Bounds | None,
        distance: float,
    ) -> CandidatePath:
        measurement = path.measure(
            bounds=bounds,
            min_step_distance=self.constants["minimum_step_distance"],
        )
        score_components = self._score_candidate(distance=distance, measurement=measurement)
        return CandidatePath(
            identifier=identifier,
            kind=kind,
            side=side,
            table_a_scale=table_a_scale,
            table_b_scale=table_b_scale,
            score=score_components.total_score,
            score_components=score_components,
            measurement=measurement,
            path=path,
        )


def _derive_bundle_root(binary_path: Path) -> Path:
    if binary_path.parent.name == "MacOS" and binary_path.parent.parent.name == "Contents":
        return binary_path.parent.parent.parent
    return binary_path.parent


def scan_bundle_for_slider_labels(binary_path: Path) -> dict[str, object]:
    bundle_root = _derive_bundle_root(binary_path)
    exact_slider_phrases = [
        "START HANDLE",
        "END HANDLE",
        "ARC SIZE",
        "ARC FLOW",
    ]
    ambiguous_single_tokens = [
        "SPRING",
        "DEBUG",
        "MAIL",
        "CLICK",
    ]
    exact_findings = {label: False for label in exact_slider_phrases}
    ambiguous_findings = {label: False for label in ambiguous_single_tokens}
    files_scanned = 0

    for file_path in bundle_root.rglob("*"):
        if not file_path.is_file():
            continue
        files_scanned += 1
        try:
            payload = file_path.read_bytes().lower()
        except OSError:
            continue

        for label in exact_slider_phrases:
            if exact_findings[label]:
                continue
            if label.lower().encode("utf-8") in payload:
                exact_findings[label] = True

        for label in ambiguous_single_tokens:
            if ambiguous_findings[label]:
                continue
            if label.lower().encode("utf-8") in payload:
                ambiguous_findings[label] = True

    return {
        "bundle_root": str(bundle_root),
        "files_scanned": files_scanned,
        "exact_slider_phrases": exact_findings,
        "ambiguous_single_tokens": ambiguous_findings,
        "notes": {
            "exact_slider_phrase_scan": "used to check whether the shipping bundle still carries the specific slider UI labels from the video.",
            "ambiguous_single_token_scan": "single words like SPRING / DEBUG / MAIL / CLICK can appear for unrelated reasons in a release bundle, so these hits are not enough to claim the debug UI still ships.",
        },
    }


def summarize_path_shape(path: CursorMotionPath, sample_count: int = 128) -> dict[str, float | list[float]]:
    chord = path.end - path.start
    chord_length = chord.length()
    chord_direction = chord.normalized() if chord_length > 1e-9 else Vec2(1.0, 0.0)
    normal = chord_direction.perpendicular()

    max_signed_offset = 0.0
    apex_progress = 0.0
    for sample in path.sample_points(sample_count):
        offset_vector = sample.point - path.start
        signed_offset = (offset_vector.x * normal.x) + (offset_vector.y * normal.y)
        if abs(signed_offset) > abs(max_signed_offset):
            max_signed_offset = signed_offset
            apex_progress = sample.progress

    start_tangent = path.sample(0.04)[1]
    end_tangent = path.sample(0.96)[1]
    return {
        "chord_length": chord_length,
        "max_signed_offset_from_chord": max_signed_offset,
        "max_offset_from_chord": abs(max_signed_offset),
        "apex_progress": apex_progress,
        "start_heading_error_degrees": math.degrees(signed_angle(chord_direction, start_tangent)),
        "end_heading_error_degrees": math.degrees(signed_angle(chord_direction, end_tangent)),
    }


def summarize_candidate_geometry(candidate: CandidatePath, sample_count: int = 128) -> dict[str, object]:
    return {
        "identifier": candidate.identifier,
        "kind": candidate.kind,
        "side": candidate.side,
        "measurement": candidate.measurement.to_dict(),
        "shape_metrics": summarize_path_shape(candidate.path, sample_count=sample_count),
        "control_points": {
            "start_control": candidate.path.start_control.to_list() if candidate.path.start_control else None,
            "arc": candidate.path.arc.to_list() if candidate.path.arc else None,
            "arc_in": candidate.path.arc_in.to_list() if candidate.path.arc_in else None,
            "arc_out": candidate.path.arc_out.to_list() if candidate.path.arc_out else None,
            "end_control": candidate.path.end_control.to_list() if candidate.path.end_control else None,
        },
    }


def _find_best_arched_candidate(candidates: list[CandidatePath]) -> CandidatePath | None:
    arched = [candidate for candidate in candidates if candidate.kind == "arched"]
    if not arched:
        return None
    in_bounds = [candidate for candidate in arched if candidate.measurement.stays_in_bounds]
    pool = in_bounds if in_bounds else arched
    return min(pool, key=lambda item: item.score)


def _build_geometry_slider_variants(
    generator: BinaryGuidedPathGenerator,
    start: Vec2,
    end: Vec2,
    bounds: Bounds | None,
    sample_count: int,
    variant_overrides: list[tuple[str, BinaryGuidedPathOverrides]],
) -> list[dict[str, object]]:
    payload: list[dict[str, object]] = []
    for name, overrides in variant_overrides:
        candidates = generator.build_candidates(start=start, end=end, bounds=bounds, overrides=overrides)
        chosen_candidate, selection_policy = generator.choose_candidate(candidates)
        best_arched = _find_best_arched_candidate(candidates)
        payload.append(
            {
                "variant": name,
                "selection_policy": selection_policy,
                "chosen_candidate": summarize_candidate_geometry(chosen_candidate, sample_count=sample_count)
                if chosen_candidate
                else None,
                "best_arched_candidate": summarize_candidate_geometry(best_arched, sample_count=sample_count)
                if best_arched
                else None,
            }
        )
    return payload


def build_slider_study_output(
    binary: MachOBinary,
    start: Vec2,
    end: Vec2,
    bounds: Bounds | None,
    sample_count: int,
) -> dict[str, object]:
    constants = build_model_constants(binary)
    tables = extract_candidate_tables(binary)
    generator = BinaryGuidedPathGenerator(constants=constants, tables=tables)
    baseline_candidates = generator.build_candidates(start=start, end=end, bounds=bounds)
    baseline_choice, selection_policy = generator.choose_candidate(baseline_candidates)
    baseline_best_arched = _find_best_arched_candidate(baseline_candidates)

    if baseline_choice is None:
        raise ValueError("no baseline candidate produced for slider study")

    baseline_timeline = build_timed_cursor_timeline(path=baseline_choice.path)
    spring_response_baseline = CONFIRMED_CURSOR_TIMING_CONSTANTS["cursor_path_spring_response"]
    spring_damping_baseline = CONFIRMED_CURSOR_TIMING_CONSTANTS["cursor_path_spring_damping_fraction"]
    spring_variants = [
        (
            "response_minus_15pct",
            build_scalar_spring_configuration_for(
                response=spring_response_baseline * 0.85,
                damping_fraction=spring_damping_baseline,
            ),
        ),
        (
            "response_plus_15pct",
            build_scalar_spring_configuration_for(
                response=spring_response_baseline * 1.15,
                damping_fraction=spring_damping_baseline,
            ),
        ),
    ]
    spring_variant_payload = []
    for name, config in spring_variants:
        timeline = build_timed_cursor_timeline(path=baseline_choice.path, config=config)
        spring_variant_payload.append(
            {
                "variant": name,
                "spring_configuration": config.to_dict(),
                "timed_cursor_timeline": {
                    "first_endpoint_lock_time": timeline["first_endpoint_lock_time"],
                    "close_enough_first_time": timeline["close_enough_first_time"],
                    "raw_progress_first_ge_target_time": timeline["raw_progress_first_ge_target_time"],
                },
            }
        )

    return {
        "binary_path": str(binary.path),
        "input": {
            "start": start.to_list(),
            "end": end.to_list(),
            "bounds": asdict(bounds) if bounds else None,
            "sample_count": sample_count,
        },
        "shipping_bundle_label_evidence": scan_bundle_for_slider_labels(binary.path),
        "binary_confirmed_motion_terms": {
            "path_fields": ["startControl", "arc", "arcIn", "arcOut", "endControl"],
            "timing_fields": ["Animation.SpringParameters.response", "Animation.SpringParameters.dampingFraction"],
            "candidate_tables": extract_candidate_tables(binary),
            "fixed_geometry_constants": {
                "guide_vector": [-0.6946583704589973, 0.7193398003386512],
                "start_extent_piecewise": "48 / d*0.41960295031576633 / 640 depending on region",
                "end_extent_piecewise": "48 / d*0.9 / 640 depending on region",
                "handle_extent_piecewise": "50 / d*0.2765523188064277 / 520",
                "arc_extent_piecewise": "clamp(d*0.5783555327868779, 38, 440)",
                "arc_anchor_bias": "guide * (startExtent * 0.65)",
            },
            "spring_defaults": {
                "response": spring_response_baseline,
                "damping_fraction": spring_damping_baseline,
                "dt": CONFIRMED_CURSOR_TIMING_CONSTANTS["velocity_verlet_dt"],
            },
        },
        "baseline": {
            "selection_policy": selection_policy,
            "chosen_candidate": summarize_candidate_geometry(baseline_choice, sample_count=sample_count),
            "best_arched_candidate": summarize_candidate_geometry(baseline_best_arched, sample_count=sample_count)
            if baseline_best_arched
            else None,
            "timed_cursor_timeline": {
                "spring_configuration": baseline_timeline["spring_configuration"],
                "first_endpoint_lock_time": baseline_timeline["first_endpoint_lock_time"],
                "close_enough_first_time": baseline_timeline["close_enough_first_time"],
            },
        },
        "slider_mapping_analysis": {
            "start_handle": {
                "release_bundle_label_found": False,
                "mapping_confidence": "inferred_from_binary_fields",
                "affects_current_baseline_choice_directly": True,
                "binary_terms_touched": ["CursorMotionPath.startControl", "guide startExtent piecewise"],
                "effect_summary": "changes how far the launch-side control point projects along the guide direction, so it mainly changes the first third of the curve and the initial heading commitment.",
                "variants": _build_geometry_slider_variants(
                    generator=generator,
                    start=start,
                    end=end,
                    bounds=bounds,
                    sample_count=sample_count,
                    variant_overrides=[
                        ("start_extent_minus_25pct", BinaryGuidedPathOverrides(start_extent_scale=0.75)),
                        ("start_extent_plus_25pct", BinaryGuidedPathOverrides(start_extent_scale=1.25)),
                    ],
                ),
            },
            "end_handle": {
                "release_bundle_label_found": False,
                "mapping_confidence": "inferred_from_binary_fields",
                "affects_current_baseline_choice_directly": True,
                "binary_terms_touched": ["CursorMotionPath.endControl", "guide endExtent piecewise"],
                "effect_summary": "changes how far the arrival-side control point projects before the endpoint, so it mainly changes the terminal braking / hook-in segment and the final tangent alignment.",
                "variants": _build_geometry_slider_variants(
                    generator=generator,
                    start=start,
                    end=end,
                    bounds=bounds,
                    sample_count=sample_count,
                    variant_overrides=[
                        ("end_extent_minus_25pct", BinaryGuidedPathOverrides(end_extent_scale=0.75)),
                        ("end_extent_plus_25pct", BinaryGuidedPathOverrides(end_extent_scale=1.25)),
                    ],
                ),
            },
            "arc_size": {
                "release_bundle_label_found": False,
                "mapping_confidence": "inferred_from_binary_fields",
                "affects_current_baseline_choice_directly": baseline_choice.kind == "arched",
                "binary_terms_touched": ["handleExtent piecewise", "arcExtent piecewise", "table_a", "table_b"],
                "effect_summary": "changes how far the arched family pushes the apex off the chord and how wide the arc tangents open, so it mainly changes peak bowing, total turn, and path length.",
                "variants": _build_geometry_slider_variants(
                    generator=generator,
                    start=start,
                    end=end,
                    bounds=bounds,
                    sample_count=sample_count,
                    variant_overrides=[
                        ("arc_size_minus_30pct", BinaryGuidedPathOverrides(arc_size_scale=0.7)),
                        ("arc_size_plus_30pct", BinaryGuidedPathOverrides(arc_size_scale=1.3)),
                    ],
                ),
            },
            "arc_flow": {
                "release_bundle_label_found": False,
                "mapping_confidence": "inferred_from_binary_fields",
                "affects_current_baseline_choice_directly": baseline_choice.kind == "arched",
                "binary_terms_touched": ["arc_anchor_bias = guide * (startExtent * 0.65)"],
                "effect_summary": "the current lift has no dedicated flow field, but the fixed arc-anchor bias shifts the apex forward along the guide direction; perturbing it mainly moves where the curve reaches its widest bow, making the turn feel earlier or later.",
                "variants": _build_geometry_slider_variants(
                    generator=generator,
                    start=start,
                    end=end,
                    bounds=bounds,
                    sample_count=sample_count,
                    variant_overrides=[
                        ("arc_flow_minus_25pct", BinaryGuidedPathOverrides(arc_flow_scale=0.75)),
                        ("arc_flow_plus_25pct", BinaryGuidedPathOverrides(arc_flow_scale=1.25)),
                    ],
                ),
            },
            "spring": {
                "release_bundle_label_found": False,
                "mapping_confidence": "direct_binary_timing_fields_confirmed_but_one_dimensional_ui_mapping_unrecovered",
                "affects_current_baseline_choice_directly": True,
                "binary_terms_touched": ["Animation.SpringParameters.response", "Animation.SpringParameters.dampingFraction"],
                "effect_summary": "shipping cursor motion definitely uses SpringParameters(response=1.4, dampingFraction=0.9); varying response changes endpoint-lock timing and how quickly progress approaches 1.0, but the exact single-slider mapping used by the internal debug UI is still unrecovered.",
                "normalization_helper_note": CONFIRMED_TIMING_PIPELINE["spring_parameter_normalization_helper"],
                "variants": spring_variant_payload,
            },
        },
    }


def build_inspect_output(binary: MachOBinary) -> dict[str, object]:
    guide_vector = [-0.6946583704589973, 0.7193398003386512]
    return {
        "binary_path": str(binary.path),
        "motion_types": [asdict(item) for item in extract_motion_type_fields(binary)],
        "data_section_constants": extract_named_constants(binary),
        "confirmed_model_constants": CONFIRMED_DISASSEMBLY_CONSTANTS,
        "confirmed_timing_constants": CONFIRMED_CURSOR_TIMING_CONSTANTS,
        "candidate_tables": extract_candidate_tables(binary),
        "confirmed_from_binary": {
            "path_sample_function": "segment selection + cubic bezier evaluation",
            "measurement_function": "24 samples per segment + angle unwrap + in-bounds flag",
            "candidate_tables_shape": "3 x 3 coefficient tables with mirrored path variants",
            "candidate_count_shape": "2 base candidates + 3 x 3 x 2 mirrored candidates = 20",
            "guide_vector": guide_vector,
            "path_struct_layout": {
                "start": "offset 0x00",
                "end": "offset 0x10",
                "startControl": "offset 0x20",
                "arc": "offset 0x30",
                "arcIn": "offset 0x48",
                "arcOut": "offset 0x60",
                "endControl": "offset 0x78",
                "segments": "offset 0x88",
            },
            "segment_struct_layout": {
                "end": "offset 0x00",
                "control1": "offset 0x10",
                "control2": "offset 0x20",
            },
            "guide_extent_piecewise": {
                "start_extent": "48 if d*0.41960295031576633 < 48; d*0.41960295031576633 if d*0.41960295031576633 < 640; 640 if d*0.15 < 640; else 640",
                "end_extent": "48 if d*0.41960295031576633 < 48; d*0.9 if d*0.41960295031576633 < 640; 48 if d*0.15 < 640; else 640",
            },
            "handle_extent_piecewise": "50 if d*0.2765523188064277 < 50; d*0.2765523188064277 if d*0.2765523188064277 < 640; else 520",
            "arc_extent_piecewise": "clamp(d*0.5783555327868779, 38, 440)",
            "candidate_score_formula": "320 * max(length / max(directDistance, 1) - 1, 0) + 140 * angleEnergy + 180 * maxAngle + 18 * totalTurn + 45 * outOfBounds",
            "candidate_selection_policy": "prefer in-bounds candidates, otherwise fall back to all candidates, then choose the minimum score",
            "velocity_verlet_stiffness_formula": "stiffness = min(response > 0 ? (2π / response)^2 : +inf, 28800)",
            "velocity_verlet_drag_formula": "drag = 2 * dampingFraction * sqrt(stiffness)",
            "velocity_verlet_step_sequence": [
                "velocityHalf = velocity + force * (dt / 2)",
                "current = current + velocityHalf * dt",
                "force = stiffness * (target - current) + (-drag) * velocityHalf",
                "velocity = velocityHalf + force * (dt / 2)",
            ],
            "spring_animation_frame_update": {
                "function": "0x1005761bc",
                "behavior": "advance simulation, evaluate finished predicate, return optional nil on finish else some(updatedValue)",
                "value_copy_helper": "0x1005730bc reads hidden self offset 0x68",
                "target_copy_helper": "0x100573390 reads hidden self offset 0x70",
            },
            "spring_animation_finish_predicate": {
                "function": "0x1005934b0",
                "threshold_square_gate": "requires max(hiddenStateSlotA, hiddenStateSlotB) <= threshold^2 before continuing",
                "exact_zero_gate": "after a 0.01 float-literal broadcast and SIMD scalar loops, accepts only when a difference-derived scalar A is neither A > 0 nor 0 > A",
                "field_name_inference_notes": {
                    "hidden_self_0x68_0x70": "very likely InterpolatableAnimation._value / _targetValue",
                    "metadata_plus_0x30_threshold": "very likely idleVelocityThreshold",
                },
            },
        },
        "timing_from_binary": {
            "type_relationships": CONFIRMED_TIMING_TYPE_RELATIONSHIPS,
            "cursor_path_constants": CONFIRMED_CURSOR_TIMING_CONSTANTS,
            "pipeline": CONFIRMED_TIMING_PIPELINE,
        },
    }


def build_demo_output(
    binary: MachOBinary,
    start: Vec2,
    end: Vec2,
    bounds: Bounds | None,
    sample_count: int,
    include_all_candidates: bool,
) -> dict[str, object]:
    constants = build_model_constants(binary)
    tables = extract_candidate_tables(binary)
    generator = BinaryGuidedPathGenerator(constants=constants, tables=tables)
    candidates = generator.build_candidates(start=start, end=end, bounds=bounds)
    chosen_candidate, selection_policy = generator.choose_candidate(candidates)
    ordered_candidates = sorted(candidates, key=lambda item: (not item.measurement.stays_in_bounds, item.score))
    timed_timeline = build_timed_cursor_timeline(chosen_candidate.path) if chosen_candidate else None
    return {
        "binary_path": str(binary.path),
        "input": {
            "start": start.to_list(),
            "end": end.to_list(),
            "bounds": asdict(bounds) if bounds else None,
            "sample_count": sample_count,
        },
        "confirmed_model_constants": CONFIRMED_DISASSEMBLY_CONSTANTS,
        "confirmed_timing_constants": CONFIRMED_CURSOR_TIMING_CONSTANTS,
        "confirmed_from_binary": {
            "sample_progress_logic": True,
            "measurement_logic": True,
            "candidate_coeff_tables": True,
            "candidate_geometry_lifted_from_disassembly": True,
            "candidate_score_formula": True,
            "candidate_selection_policy": True,
            "spring_animation_chain": True,
            "velocity_verlet_configuration_fields": True,
            "window_animation_state_slots": True,
            "velocity_verlet_step_sequence": True,
            "stiffness_formula": True,
            "drag_formula": True,
            "spring_animation_finished_predicate_control_flow": True,
        },
        "reconstructed_or_inferred": {
            "automatic_bounds_discovery_from_runtime": True,
            "wall_clock_duration_model": True,
            "spring_animation_value_target_field_names": True,
            "endpoint_lock_to_finished_predicate_linkage": True,
        },
        "timing_notes": {
            "duration_recovered_from_binary": False,
            "sample_speed_is_geometric": True,
            "sample_speed_definition": "distance between adjacent time-stepped path points divided by dt",
            "spring_response_and_damping_recovered": True,
            "velocity_verlet_dt_recovered": True,
            "velocity_verlet_idle_velocity_threshold_recovered": True,
            "spring_animation_finish_predicate_control_flow_recovered": True,
        },
        "timing_binary_evidence": {
            "type_relationships": CONFIRMED_TIMING_TYPE_RELATIONSHIPS,
            "pipeline": CONFIRMED_TIMING_PIPELINE,
        },
        "candidate_shape_notes": {
            "confirmed_binary_candidate_count": 20,
            "demo_candidate_count": len(candidates),
            "bounds_note": "the bundled app derives bounds from runtime screen regions before calling the path builder; this script expects bounds as direct input",
        },
        "selection_policy": selection_policy,
        "timed_cursor_demo": timed_timeline,
        "candidate_summaries": [candidate.summary_dict() for candidate in ordered_candidates],
        "chosen_candidate": chosen_candidate.to_dict(sample_count=sample_count) if chosen_candidate else None,
        "all_candidates": [candidate.to_dict(sample_count=sample_count) for candidate in ordered_candidates]
        if include_all_candidates
        else None,
    }


def parse_vec2(values: Iterable[str]) -> Vec2:
    x_raw, y_raw = values
    return Vec2(float(x_raw), float(y_raw))


def parse_bounds(values: Iterable[str]) -> Bounds:
    min_x, min_y, max_x, max_y = (float(item) for item in values)
    return Bounds(min_x=min_x, min_y=min_y, max_x=max_x, max_y=max_y)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Reverse-engineering helpers for official cursor motion.")
    parser.add_argument("--app", type=Path, default=DEFAULT_APP_PATH, help="Path to SkyComputerUseService binary.")
    parser.add_argument("--pretty", dest="pretty_global", action="store_true", help="Pretty-print JSON output.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    inspect = subparsers.add_parser("inspect", help="Dump recovered motion types, constants, and coefficient tables.")
    inspect.add_argument("--pretty", dest="pretty_local", action="store_true", help="Pretty-print JSON output.")

    demo = subparsers.add_parser("demo", help="Generate binary-guided candidate cursor paths.")
    demo.add_argument("--pretty", dest="pretty_local", action="store_true", help="Pretty-print JSON output.")
    demo.add_argument("--start", nargs=2, metavar=("X", "Y"), required=True, help="Start position.")
    demo.add_argument("--end", nargs=2, metavar=("X", "Y"), required=True, help="End position.")
    demo.add_argument(
        "--bounds",
        nargs=4,
        metavar=("MIN_X", "MIN_Y", "MAX_X", "MAX_Y"),
        help="Optional bounds used for stays_in_bounds measurement.",
    )
    demo.add_argument("--samples", type=int, default=32, help="Number of sample points per candidate.")
    demo.add_argument(
        "--include-all-candidates",
        action="store_true",
        help="Include full path and sample output for every candidate instead of only the chosen candidate.",
    )

    slider_study = subparsers.add_parser(
        "slider-study",
        help="Study how slider-like parameter hypotheses map onto binary-confirmed geometry and spring terms.",
    )
    slider_study.add_argument("--pretty", dest="pretty_local", action="store_true", help="Pretty-print JSON output.")
    slider_study.add_argument("--start", nargs=2, metavar=("X", "Y"), required=True, help="Start position.")
    slider_study.add_argument("--end", nargs=2, metavar=("X", "Y"), required=True, help="End position.")
    slider_study.add_argument(
        "--bounds",
        nargs=4,
        metavar=("MIN_X", "MIN_Y", "MAX_X", "MAX_Y"),
        help="Optional bounds used for stays_in_bounds measurement.",
    )
    slider_study.add_argument("--samples", type=int, default=96, help="Number of sample points used for geometry summaries.")

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    binary = MachOBinary(args.app)
    if args.command == "inspect":
        payload = build_inspect_output(binary)
    elif args.command == "demo":
        start = parse_vec2(args.start)
        end = parse_vec2(args.end)
        bounds = parse_bounds(args.bounds) if args.bounds else None
        payload = build_demo_output(
            binary,
            start=start,
            end=end,
            bounds=bounds,
            sample_count=args.samples,
            include_all_candidates=args.include_all_candidates,
        )
    elif args.command == "slider-study":
        start = parse_vec2(args.start)
        end = parse_vec2(args.end)
        bounds = parse_bounds(args.bounds) if args.bounds else None
        payload = build_slider_study_output(
            binary,
            start=start,
            end=end,
            bounds=bounds,
            sample_count=args.samples,
        )
    else:
        raise AssertionError(f"unsupported command: {args.command}")

    pretty = args.pretty_global or getattr(args, "pretty_local", False)
    import sys

    json.dump(payload, fp=sys.stdout, ensure_ascii=True, indent=2 if pretty else None)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
