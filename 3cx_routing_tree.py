#!/usr/bin/env python3
"""
3cx_routing_tree.py — Extract a visual routing tree from a 3CX backup zip.

Usage:
    python3 3cx_routing_tree.py <path-to-3CXScheduledBackup.zip> [-o output.html]

Produces a self-contained HTML file with an interactive Mermaid flowchart of
the inbound call flow: trunks → DID rules → IVRs / ring groups / queues /
extensions / voicemail. Also lists IVR menu options, ring group members,
queue agents, and time-of-day exception routes.

No external dependencies required at runtime (Mermaid is loaded from a CDN,
and a printable plain-text fallback is included in the same file).
"""
from __future__ import annotations

import argparse
import html
import sys
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class Destination:
    """A routing target. `kind` is e.g. Extension/IVR/RingGroup/Queue/VoiceMail/External/None."""
    kind: str
    dn: str = ""           # internal DN if kind is internal
    external: str = ""     # external number if kind == External
    raw: str = ""          # original string for debugging

    @property
    def label(self) -> str:
        if self.kind in ("None", "EndCall", "RepeatPrompt", "ProceedWithNoExceptions"):
            return self.kind
        if self.kind == "External" and self.external:
            return f"External {self.external}"
        if self.dn:
            return f"{self.kind} {self.dn}"
        return self.kind


@dataclass
class DIDRule:
    rule_name: str
    condition: str           # BasedOnDID / ForwardAll / etc.
    match: str               # the DID number, or "" for ForwardAll
    office: Optional[Destination] = None
    out_of_hours: Optional[Destination] = None
    holidays: Optional[Destination] = None


@dataclass
class Trunk:
    number: str
    name: str
    dids: list[str] = field(default_factory=list)
    direction: str = ""
    rules: list[DIDRule] = field(default_factory=list)


@dataclass
class IVRMenuOption:
    digit: str
    forward_type: str
    forward_dn: str


@dataclass
class IVR:
    number: str
    name: str
    prompt: str
    timeout: str
    on_timeout: str
    options: list[IVRMenuOption] = field(default_factory=list)
    office_route: str = ""
    out_of_hours_route: str = ""
    break_route: str = ""
    holidays_route: str = ""


@dataclass
class RingGroup:
    number: str
    name: str
    strategy: str
    ring_time: str
    members: list[str] = field(default_factory=list)
    no_answer_dest: Optional[Destination] = None


@dataclass
class Queue:
    number: str
    name: str
    polling: str
    ring_timeout: str
    master_timeout: str
    intro_file: str
    on_hold_file: str
    members: list[str] = field(default_factory=list)
    timeout_dest: Optional[Destination] = None


@dataclass
class Extension:
    number: str
    first_name: str
    last_name: str
    enabled: bool
    email: str = ""

    @property
    def display(self) -> str:
        full = f"{self.first_name} {self.last_name}".strip()
        return full or self.number


@dataclass
class System:
    trunks: list[Trunk] = field(default_factory=list)
    ivrs: dict[str, IVR] = field(default_factory=dict)
    ring_groups: dict[str, RingGroup] = field(default_factory=dict)
    queues: dict[str, Queue] = field(default_factory=dict)
    extensions: dict[str, Extension] = field(default_factory=dict)
    route_points: dict[str, str] = field(default_factory=dict)  # number -> name

    def label_for(self, kind: str, dn: str) -> str:
        if kind == "Extension" and dn in self.extensions:
            return f"{dn} ({self.extensions[dn].display})"
        if kind == "RingGroup" and dn in self.ring_groups:
            return f"RG {dn} ({self.ring_groups[dn].name or 'unnamed'})"
        if kind == "Queue" and dn in self.queues:
            return f"Queue {dn} ({self.queues[dn].name or 'unnamed'})"
        if kind == "IVR" and dn in self.ivrs:
            return f"IVR {dn} ({self.ivrs[dn].name or 'unnamed'})"
        if kind == "VoiceMail":
            ext = self.extensions.get(dn)
            return f"VM {dn}" + (f" ({ext.display})" if ext else "")
        if kind == "RoutePoint":
            name = self.route_points.get(dn, "")
            return f"RoutePoint {dn}" + (f" ({name})" if name else "")
        if dn:
            return f"{kind} {dn}"
        return kind


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def _text(el: Optional[ET.Element], tag: str) -> str:
    if el is None:
        return ""
    sub = el.find(tag)
    if sub is None or sub.text is None:
        return ""
    return sub.text.strip()


def _parse_route_string(raw: str) -> Optional[Destination]:
    """3CX encodes routes like 'IVR.8011.', 'VoiceMail.1000.', 'EndCall..',
    'ProceedWithNoExceptions..'. Return None for the no-op 'Proceed' case."""
    if not raw:
        return None
    parts = raw.split(".")
    kind = parts[0] if parts else raw
    dn = parts[1] if len(parts) > 1 else ""
    if kind == "ProceedWithNoExceptions":
        return None
    return Destination(kind=kind, dn=dn, raw=raw)


def _parse_destination_element(el: Optional[ET.Element]) -> Optional[Destination]:
    """Parse a <…Destination> element with <To>, <Internal DN=…/>, <External>."""
    if el is None:
        return None
    to = _text(el, "To")
    if not to or to == "None":
        return Destination(kind="None") if to == "None" else None
    intern = el.find("Internal")
    extern = el.find("External")
    dn = intern.attrib.get("DN", "") if intern is not None else ""
    ext = extern.text.strip() if extern is not None and extern.text else ""
    return Destination(kind=to, dn=dn, external=ext)


# ---------------------------------------------------------------------------
# Backup loading
# ---------------------------------------------------------------------------

def _find_db_xml(zf: zipfile.ZipFile) -> str:
    """The main DB file in a 3CX backup is named '<id>Db.xml' at the root."""
    candidates = [
        n for n in zf.namelist()
        if n.endswith("Db.xml") and "/" not in n.rstrip("/")
    ]
    if not candidates:
        raise ValueError("No '<id>Db.xml' file found at the root of the backup.")
    # If there are multiple, prefer the largest — that's the real one.
    candidates.sort(key=lambda n: zf.getinfo(n).file_size, reverse=True)
    return candidates[0]


def load_backup(zip_path: Path) -> System:
    with zipfile.ZipFile(zip_path) as zf:
        db_name = _find_db_xml(zf)
        with zf.open(db_name) as f:
            tree = ET.parse(f)
    return _parse_system(tree.getroot())


def _parse_system(root: ET.Element) -> System:
    system = System()
    tenants = root.find("Tenants")
    if tenants is None or len(tenants) == 0:
        return system
    tenant = tenants[0]
    dn_container = tenant.find("DN")
    if dn_container is None:
        return system

    # First pass: extensions, IVRs, ring groups, queues, route points (so we
    # can build labels in the second pass).
    for child in dn_container:
        if child.tag == "Extension":
            system.extensions[_text(child, "Number")] = Extension(
                number=_text(child, "Number"),
                first_name=_text(child, "FirstName"),
                last_name=_text(child, "LastName"),
                enabled=_text(child, "Enabled").lower() == "true",
                email=_text(child, "EmailAddress"),
            )
        elif child.tag == "IVR":
            ivr = IVR(
                number=_text(child, "Number"),
                name=_text(child, "Name"),
                prompt=_text(child, "PromptFilename"),
                timeout=_text(child, "Timeout"),
                on_timeout=_text(child, "TimeoutForwardType"),
                office_route=_text(child, "OfficeHoursRoute"),
                out_of_hours_route=_text(child, "OutOfOfficeHoursRoute"),
                break_route=_text(child, "BreakTimeRoute"),
                holidays_route=_text(child, "HolidaysRoute"),
            )
            for f in child.findall(".//IVRForward"):
                ivr.options.append(IVRMenuOption(
                    digit=_text(f, "Number"),
                    forward_type=_text(f, "ForwardType"),
                    forward_dn=_text(f, "ForwardDN"),
                ))
            system.ivrs[ivr.number] = ivr
        elif child.tag == "RingGroup":
            rg = RingGroup(
                number=_text(child, "Number"),
                name=_text(child, "Name"),
                strategy=_text(child, "RingStrategy"),
                ring_time=_text(child, "RingTime"),
            )
            members_el = child.find("Members")
            if members_el is not None:
                for m in members_el.findall("Member"):
                    if "DN" in m.attrib:
                        rg.members.append(m.attrib["DN"])
            dest = child.find("Destination")
            if dest is not None:
                kind = _text(dest, "ForwardType")
                dn = _text(dest, "ForwardDN")
                if kind:
                    rg.no_answer_dest = Destination(kind=kind, dn=dn)
            system.ring_groups[rg.number] = rg
        elif child.tag == "Queue":
            q = Queue(
                number=_text(child, "Number"),
                name=_text(child, "Name"),
                polling=_text(child, "PollingStrategy"),
                ring_timeout=_text(child, "RingTimeout"),
                master_timeout=_text(child, "MasterTimeout"),
                intro_file=_text(child, "IntroFile"),
                on_hold_file=_text(child, "OnHoldFile"),
            )
            members_el = child.find("Members")
            if members_el is not None:
                for m in members_el.findall("Member"):
                    if "DN" in m.attrib:
                        q.members.append(m.attrib["DN"])
            dest = child.find("Destination")
            if dest is not None:
                kind = _text(dest, "ForwardType")
                dn = _text(dest, "ForwardDN")
                if kind:
                    q.timeout_dest = Destination(kind=kind, dn=dn)
            system.queues[q.number] = q
        elif child.tag == "RoutePoint":
            system.route_points[_text(child, "Number")] = _text(child, "Name")

    # Second pass: trunks (which depend on the DN map only for labelling).
    for child in dn_container:
        if child.tag != "ExternalLine":
            continue
        gw = child.find("Gateway")
        gw_name = _text(gw, "Name") if gw is not None else _text(child, "Gateway")
        # If <Gateway> is a leaf element, _text on the parent works.
        if not gw_name:
            gw_name = _text(child, "Gateway")
        trunk = Trunk(
            number=_text(child, "Number"),
            name=gw_name,
            dids=[d for d in _text(child, "DIDNumbers").split(",") if d],
            direction=_text(child, "Direction"),
        )
        rr = child.find("RoutingRules")
        if rr is not None:
            for rule_el in rr.findall("ExternalLineRule"):
                cond = rule_el.find("Conditions")
                cond_type = ""
                if cond is not None:
                    c = cond.find("Condition")
                    if c is not None:
                        cond_type = c.attrib.get("Type", "")
                fd = rule_el.find("ForwardDestinations")
                rule = DIDRule(
                    rule_name=_text(rule_el, "RuleName"),
                    condition=cond_type,
                    match=_text(rule_el, "Data"),
                    office=_parse_destination_element(
                        fd.find("OfficeHoursDestination") if fd is not None else None),
                    out_of_hours=_parse_destination_element(
                        fd.find("OutOfOfficeHoursDestination") if fd is not None else None),
                    holidays=_parse_destination_element(
                        fd.find("HolidaysDestination") if fd is not None else None),
                )
                trunk.rules.append(rule)
        system.trunks.append(trunk)

    return system


# ---------------------------------------------------------------------------
# Serialization for the JS viewer
# ---------------------------------------------------------------------------

import json
from dataclasses import asdict


def system_to_json(system: System) -> str:
    """Serialize the parsed system to JSON for the embedded viewer."""
    payload = {
        "trunks": [
            {
                "number": t.number,
                "name": t.name,
                "direction": t.direction,
                "dids": t.dids,
                "rules": [
                    {
                        "rule_name": r.rule_name,
                        "condition": r.condition,
                        "match": r.match,
                        "office": asdict(r.office) if r.office else None,
                        "out_of_hours": asdict(r.out_of_hours) if r.out_of_hours else None,
                        "holidays": asdict(r.holidays) if r.holidays else None,
                    }
                    for r in t.rules
                ],
            }
            for t in system.trunks
        ],
        "ivrs": {
            num: {
                "number": ivr.number,
                "name": ivr.name,
                "prompt": ivr.prompt,
                "timeout": ivr.timeout,
                "on_timeout": ivr.on_timeout,
                "options": [asdict(o) for o in ivr.options],
                "office_route": ivr.office_route,
                "out_of_hours_route": ivr.out_of_hours_route,
                "break_route": ivr.break_route,
                "holidays_route": ivr.holidays_route,
            }
            for num, ivr in system.ivrs.items()
        },
        "ring_groups": {
            num: {
                "number": rg.number,
                "name": rg.name,
                "strategy": rg.strategy,
                "ring_time": rg.ring_time,
                "members": rg.members,
                "no_answer_dest": asdict(rg.no_answer_dest) if rg.no_answer_dest else None,
            }
            for num, rg in system.ring_groups.items()
        },
        "queues": {
            num: {
                "number": q.number,
                "name": q.name,
                "polling": q.polling,
                "ring_timeout": q.ring_timeout,
                "master_timeout": q.master_timeout,
                "intro_file": q.intro_file,
                "on_hold_file": q.on_hold_file,
                "members": q.members,
                "timeout_dest": asdict(q.timeout_dest) if q.timeout_dest else None,
            }
            for num, q in system.queues.items()
        },
        "extensions": {
            num: {
                "number": ext.number,
                "first_name": ext.first_name,
                "last_name": ext.last_name,
                "display": ext.display,
                "enabled": ext.enabled,
                "email": ext.email,
            }
            for num, ext in system.extensions.items()
        },
        "route_points": system.route_points,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Mermaid generation (kept for --mermaid-only flag and debugging)
# ---------------------------------------------------------------------------

def _mermaid_id(prefix: str, key: str) -> str:
    """Mermaid node IDs must be safe identifiers."""
    safe = "".join(c if c.isalnum() else "_" for c in key)
    return f"{prefix}_{safe}"


def _mermaid_label(text: str) -> str:
    """Quote a label for Mermaid. Use the [\"...\"] form to allow most chars."""
    text = text.replace("\\", "\\\\").replace('"', '&quot;')
    text = text.replace("\n", "<br/>")
    return text


def build_mermaid(system: System, include_internal_only: bool = False) -> str:
    lines: list[str] = ["flowchart LR"]
    lines.append("  classDef trunk fill:#E6F1FB,stroke:#185FA5,color:#042C53;")
    lines.append("  classDef did fill:#FAEEDA,stroke:#854F0B,color:#412402;")
    lines.append("  classDef ivr fill:#EEEDFE,stroke:#534AB7,color:#26215C;")
    lines.append("  classDef rg fill:#E1F5EE,stroke:#0F6E56,color:#04342C;")
    lines.append("  classDef queue fill:#E1F5EE,stroke:#0F6E56,color:#04342C,stroke-width:2px;")
    lines.append("  classDef ext fill:#FAECE7,stroke:#993C1D,color:#4A1B0C;")
    lines.append("  classDef vm fill:#FBEAF0,stroke:#993556,color:#4B1528;")
    lines.append("  classDef rp fill:#F1EFE8,stroke:#5F5E5A,color:#2C2C2A;")
    lines.append("  classDef terminal fill:#F1EFE8,stroke:#888780,color:#444441;")

    seen: set[str] = set()

    def emit_node(node_id: str, label: str, cls: str) -> None:
        if node_id in seen:
            return
        seen.add(node_id)
        lines.append(f'  {node_id}["{_mermaid_label(label)}"]:::{cls}')

    # Kinds that are meaningless without a DN — these are unconfigured fields
    # in the backup (e.g. <To>Extension</To> with no <Internal DN>) and we
    # treat them as "(unconfigured)" terminals rather than fake nodes.
    INTERNAL_KINDS = {"Extension", "IVR", "RingGroup", "Queue",
                      "VoiceMail", "RoutePoint"}

    def dest_node_id(dest: Destination) -> Optional[str]:
        """Return a node id for a destination, creating the node if needed."""
        if dest.kind in INTERNAL_KINDS and not dest.dn:
            nid = f"TERM_unconfigured_{dest.kind}"
            emit_node(nid, f"({dest.kind.lower()} unset)", "terminal")
            return nid
        if dest.kind == "Extension":
            ext = system.extensions.get(dest.dn)
            label = f"Ext {dest.dn}\n{ext.display}" if ext else f"Ext {dest.dn}"
            nid = _mermaid_id("EXT", dest.dn)
            emit_node(nid, label, "ext")
            return nid
        if dest.kind == "IVR":
            ivr = system.ivrs.get(dest.dn)
            name = ivr.name if ivr else ""
            label = f"IVR {dest.dn}\n{name}" if name else f"IVR {dest.dn}"
            nid = _mermaid_id("IVR", dest.dn)
            emit_node(nid, label, "ivr")
            return nid
        if dest.kind == "RingGroup":
            rg = system.ring_groups.get(dest.dn)
            name = rg.name if rg else ""
            label = f"RG {dest.dn}\n{name}" if name else f"RG {dest.dn}"
            nid = _mermaid_id("RG", dest.dn)
            emit_node(nid, label, "rg")
            return nid
        if dest.kind == "Queue":
            q = system.queues.get(dest.dn)
            name = q.name if q else ""
            label = f"Queue {dest.dn}\n{name}" if name else f"Queue {dest.dn}"
            nid = _mermaid_id("Q", dest.dn)
            emit_node(nid, label, "queue")
            return nid
        if dest.kind == "VoiceMail":
            ext = system.extensions.get(dest.dn)
            label = f"VM {dest.dn}\n{ext.display}" if ext else f"VM {dest.dn}"
            nid = _mermaid_id("VM", dest.dn)
            emit_node(nid, label, "vm")
            return nid
        if dest.kind == "RoutePoint":
            name = system.route_points.get(dest.dn, "")
            label = f"RoutePoint {dest.dn}" + (f"\n{name}" if name else "")
            nid = _mermaid_id("RP", dest.dn)
            emit_node(nid, label, "rp")
            return nid
        if dest.kind == "External":
            label = f"External\n{dest.external or '?'}"
            nid = _mermaid_id("EXTERNAL", dest.external or dest.raw or "unk")
            emit_node(nid, label, "terminal")
            return nid
        if dest.kind in ("None", "EndCall"):
            nid = _mermaid_id("TERM", dest.kind)
            emit_node(nid, dest.kind, "terminal")
            return nid
        if dest.kind == "RepeatPrompt":
            return None  # self-loop, not a separate node
        if dest.kind == "CallByName":
            nid = "TERM_CallByName"
            emit_node(nid, "Call by name", "terminal")
            return nid
        # Unknown / fallback
        nid = _mermaid_id("UNK", f"{dest.kind}_{dest.dn or dest.external}")
        emit_node(nid, dest.label, "terminal")
        return nid

    # Trunks → DID rules → destinations
    if not include_internal_only:
        for trunk in system.trunks:
            tnid = _mermaid_id("TRUNK", trunk.number)
            emit_node(tnid, f"Trunk {trunk.number}\n{trunk.name}", "trunk")
            for i, rule in enumerate(trunk.rules):
                if rule.condition == "ForwardAll":
                    label = "Catch-all"
                elif rule.match:
                    label = rule.match
                else:
                    label = rule.rule_name or rule.condition or "rule"
                rid = _mermaid_id("RULE", f"{trunk.number}_{i}")
                emit_node(rid, label, "did")
                lines.append(f"  {tnid} --> {rid}")
                # Office hours route is the primary line; out-of-hours and
                # holidays only get drawn if they differ.
                if rule.office:
                    nid = dest_node_id(rule.office)
                    if nid:
                        lines.append(f"  {rid} -->|office| {nid}")
                if rule.out_of_hours and (
                    not rule.office or
                    rule.out_of_hours.kind != rule.office.kind or
                    rule.out_of_hours.dn != rule.office.dn
                ):
                    nid = dest_node_id(rule.out_of_hours)
                    if nid:
                        lines.append(f"  {rid} -.->|out-of-hours| {nid}")
                if rule.holidays and (
                    not rule.office or
                    rule.holidays.kind != rule.office.kind or
                    rule.holidays.dn != rule.office.dn
                ):
                    nid = dest_node_id(rule.holidays)
                    if nid:
                        lines.append(f"  {rid} -.->|holidays| {nid}")

    # IVR menu options
    for ivr in system.ivrs.values():
        ivr_nid = _mermaid_id("IVR", ivr.number)
        emit_node(ivr_nid,
                  f"IVR {ivr.number}\n{ivr.name}" if ivr.name else f"IVR {ivr.number}",
                  "ivr")
        for opt in ivr.options:
            if not opt.forward_type:
                continue
            dest = Destination(kind=opt.forward_type, dn=opt.forward_dn)
            nid = dest_node_id(dest)
            if nid:
                lines.append(f"  {ivr_nid} -->|{opt.digit}| {nid}")
        # Time-of-day exception routes
        for label, raw in [
            ("out-of-hours", ivr.out_of_hours_route),
            ("break", ivr.break_route),
            ("holidays", ivr.holidays_route),
        ]:
            dest = _parse_route_string(raw)
            if dest is None:
                continue
            nid = dest_node_id(dest)
            if nid:
                lines.append(f"  {ivr_nid} -.->|{label}| {nid}")

    # Ring group members (only edges to extensions; agents are leaves)
    for rg in system.ring_groups.values():
        rg_nid = _mermaid_id("RG", rg.number)
        emit_node(rg_nid,
                  f"RG {rg.number}\n{rg.name}" if rg.name else f"RG {rg.number}",
                  "rg")
        for member in rg.members:
            ext = system.extensions.get(member)
            if not ext:
                continue
            ext_nid = _mermaid_id("EXT", member)
            emit_node(ext_nid, f"Ext {member}\n{ext.display}", "ext")
            lines.append(f"  {rg_nid} --> {ext_nid}")
        if rg.no_answer_dest:
            nid = dest_node_id(rg.no_answer_dest)
            if nid:
                lines.append(f"  {rg_nid} -.->|no answer| {nid}")

    # Queue agents
    for q in system.queues.values():
        q_nid = _mermaid_id("Q", q.number)
        emit_node(q_nid,
                  f"Queue {q.number}\n{q.name}" if q.name else f"Queue {q.number}",
                  "queue")
        for member in q.members:
            ext = system.extensions.get(member)
            if not ext:
                continue
            ext_nid = _mermaid_id("EXT", member)
            emit_node(ext_nid, f"Ext {member}\n{ext.display}", "ext")
            lines.append(f"  {q_nid} -.-> {ext_nid}")
        if q.timeout_dest:
            nid = dest_node_id(q.timeout_dest)
            if nid:
                lines.append(f"  {q_nid} -.->|timeout| {nid}")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# HTML output — interactive viewer with focused per-entry-point diagrams
# ---------------------------------------------------------------------------

HTML_TEMPLATE = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>3CX routing — __SOURCE__</title>
<style>
  :root {
    --bg: #f7f6f1;
    --panel: #ffffff;
    --fg: #262624;
    --muted: #6b6a64;
    --border: #d8d6cc;
    --hover: #ecebe3;
    --accent: #185fa5;
    --trunk: #185fa5;
    --did: #854f0b;
    --ivr: #534ab7;
    --rg: #0f6e56;
    --queue: #0f6e56;
    --ext: #993c1d;
    --vm: #993556;
    --rp: #5f5e5a;
    --terminal: #6b6a64;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1a18;
      --panel: #232220;
      --fg: #e8e6dc;
      --muted: #a4a298;
      --border: #3c3a34;
      --hover: #2d2c28;
      --accent: #6ba6e3;
      --trunk: #6ba6e3;
      --did: #f0a949;
      --ivr: #afa9ec;
      --rg: #5dcaa5;
      --queue: #5dcaa5;
      --ext: #f0997b;
      --vm: #ed93b1;
      --rp: #b4b2a9;
      --terminal: #a4a298;
    }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    background: var(--bg); color: var(--fg);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", sans-serif;
    font-size: 13px; line-height: 1.5;
  }
  .app { display: grid; grid-template-columns: 320px 1fr; height: 100vh; }
  .sidebar {
    background: var(--panel); border-right: 1px solid var(--border);
    overflow-y: auto; padding: 12px 0;
  }
  .sidebar h2 {
    margin: 16px 14px 6px; padding: 0;
    font-size: 11px; font-weight: 500; letter-spacing: 0.04em;
    color: var(--muted); text-transform: uppercase;
  }
  .sidebar h2:first-child { margin-top: 4px; }
  .row {
    display: block; padding: 8px 14px; cursor: pointer;
    border-left: 3px solid transparent;
    color: var(--fg); text-decoration: none;
  }
  .row:hover { background: var(--hover); }
  .row.active {
    background: var(--hover);
    border-left-color: var(--accent);
  }
  .row .num { font-weight: 500; }
  .row .sub { color: var(--muted); font-size: 12px; margin-top: 1px; }
  .filter {
    margin: 0 14px 8px; padding: 6px 10px;
    border: 1px solid var(--border); border-radius: 6px;
    background: var(--bg); color: var(--fg);
    font-family: inherit; font-size: 13px; width: calc(100% - 28px);
  }
  .filter:focus { outline: 1px solid var(--accent); border-color: var(--accent); }
  .main { overflow: auto; padding: 24px 28px; }
  .header { margin-bottom: 16px; }
  .header h1 { margin: 0; font-size: 18px; font-weight: 500; }
  .header .meta { color: var(--muted); margin-top: 2px; font-size: 12px; }
  .stats {
    display: flex; gap: 16px; margin: 12px 0 24px; flex-wrap: wrap;
    color: var(--muted); font-size: 12px;
  }
  .stats span strong { color: var(--fg); font-weight: 500; }

  /* Diagram canvas */
  .diagram { background: var(--panel); border: 1px solid var(--border);
             border-radius: 8px; padding: 20px; overflow-x: auto; }
  .diagram svg { display: block; }
  .node-rect { cursor: pointer; }
  .node-rect:hover { filter: brightness(0.97); }
  @media (prefers-color-scheme: dark) {
    .node-rect:hover { filter: brightness(1.15); }
  }
  .node-label-title { font-weight: 500; font-size: 13px; }
  .node-label-sub { font-size: 11px; opacity: 0.8; }
  .edge { fill: none; stroke: var(--muted); stroke-width: 1.2; }
  .edge.dashed { stroke-dasharray: 4 3; opacity: 0.7; }
  .edge-label { font-size: 11px; fill: var(--muted); }

  /* Detail panel below diagram */
  .details { margin-top: 20px; background: var(--panel); border: 1px solid var(--border);
             border-radius: 8px; padding: 16px 20px; }
  .details h3 { margin: 0 0 10px; font-size: 14px; font-weight: 500; }
  .details table { border-collapse: collapse; width: 100%; }
  .details th, .details td {
    text-align: left; padding: 5px 10px 5px 0;
    border-bottom: 1px solid var(--border); font-size: 12px;
    vertical-align: top;
  }
  .details th { font-weight: 500; color: var(--muted); }
  .details tr:last-child td { border-bottom: none; }
  .pill {
    display: inline-block; padding: 1px 7px; border-radius: 9px;
    font-size: 11px; border: 1px solid currentColor;
  }
  .empty { color: var(--muted); font-style: italic; }
  .legend { display: flex; gap: 14px; flex-wrap: wrap; margin-bottom: 12px;
            font-size: 11px; color: var(--muted); }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .legend .swatch { width: 10px; height: 10px; border-radius: 2px;
                    border: 1px solid currentColor; }
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <input class="filter" id="filter" placeholder="Filter by number, name, DID…">
    <div id="entries"></div>
  </aside>
  <main class="main">
    <div class="header">
      <h1>3CX routing tree</h1>
      <div class="meta">From <code>__SOURCE__</code></div>
    </div>
    <div class="stats" id="stats"></div>
    <div class="legend">
      <span><span class="swatch" style="color:var(--trunk)"></span>Trunk</span>
      <span><span class="swatch" style="color:var(--did)"></span>DID</span>
      <span><span class="swatch" style="color:var(--ivr)"></span>IVR</span>
      <span><span class="swatch" style="color:var(--rg)"></span>Ring group</span>
      <span><span class="swatch" style="color:var(--queue)"></span>Queue</span>
      <span><span class="swatch" style="color:var(--ext)"></span>Extension</span>
      <span><span class="swatch" style="color:var(--vm)"></span>Voicemail</span>
      <span style="opacity:.7">— solid: office hrs · dashed: out-of-hours / holiday</span>
    </div>
    <div class="diagram" id="diagram"></div>
    <div id="details"></div>
  </main>
</div>

<script id="data" type="application/json">
__DATA__
</script>
<script>
"use strict";
const data = JSON.parse(document.getElementById('data').textContent);

// ---- Helpers ------------------------------------------------------------
function destLabel(dest) {
  if (!dest) return null;
  const k = dest.kind;
  if (k === "Extension" && dest.dn) {
    const e = data.extensions[dest.dn];
    return { kind: "Extension", dn: dest.dn, label: "Ext " + dest.dn,
             sub: e ? e.display : "" };
  }
  if (k === "IVR" && dest.dn) {
    const i = data.ivrs[dest.dn];
    return { kind: "IVR", dn: dest.dn, label: "IVR " + dest.dn,
             sub: i ? i.name : "" };
  }
  if (k === "RingGroup" && dest.dn) {
    const r = data.ring_groups[dest.dn];
    return { kind: "RingGroup", dn: dest.dn, label: "RG " + dest.dn,
             sub: r ? r.name : "" };
  }
  if (k === "Queue" && dest.dn) {
    const q = data.queues[dest.dn];
    return { kind: "Queue", dn: dest.dn, label: "Queue " + dest.dn,
             sub: q ? q.name : "" };
  }
  if (k === "VoiceMail" && dest.dn) {
    const e = data.extensions[dest.dn];
    return { kind: "VoiceMail", dn: dest.dn, label: "VM " + dest.dn,
             sub: e ? e.display : "" };
  }
  if (k === "RoutePoint" && dest.dn) {
    return { kind: "RoutePoint", dn: dest.dn, label: "RoutePoint " + dest.dn,
             sub: data.route_points[dest.dn] || "" };
  }
  if (k === "External") {
    return { kind: "External", label: "External", sub: dest.external || "" };
  }
  if (k === "None" || k === "EndCall") return { kind: "Terminal", label: k, sub: "" };
  if (k === "RepeatPrompt") return { kind: "Terminal", label: "Repeat prompt", sub: "" };
  if (k === "CallByName") return { kind: "Terminal", label: "Call by name", sub: "" };
  // Unconfigured: a kind that needs a DN but doesn't have one
  if (["Extension","IVR","RingGroup","Queue","VoiceMail","RoutePoint"].includes(k)) {
    return { kind: "Terminal", label: "(" + k.toLowerCase() + " unset)", sub: "" };
  }
  return { kind: "Terminal", label: dest.kind || "?", sub: "" };
}

function parseRouteString(raw) {
  if (!raw) return null;
  const parts = raw.split(".");
  const kind = parts[0];
  const dn = parts.length > 1 ? parts[1] : "";
  if (kind === "ProceedWithNoExceptions") return null;
  return { kind, dn, raw };
}

function colorFor(kind) {
  return ({
    Trunk: "var(--trunk)", DID: "var(--did)", IVR: "var(--ivr)",
    RingGroup: "var(--rg)", Queue: "var(--queue)", Extension: "var(--ext)",
    VoiceMail: "var(--vm)", RoutePoint: "var(--rp)",
    External: "var(--terminal)", Terminal: "var(--terminal)",
  })[kind] || "var(--muted)";
}

// ---- Sidebar entry list -------------------------------------------------
function buildEntries() {
  // Entries are the natural inbound starting points: each trunk plus any
  // "named" IVR (a customer-facing one with a prompt or menu options).
  const entries = [];
  for (const t of data.trunks) {
    entries.push({
      kind: "Trunk",
      key: "trunk:" + t.number,
      title: t.name || ("Trunk " + t.number),
      sub: "Trunk " + t.number + (t.dids.length ? " · " + t.dids.length + " DID(s)" : ""),
    });
  }
  for (const num of Object.keys(data.ivrs).sort()) {
    const i = data.ivrs[num];
    const interesting = i.options.length > 0 || (i.prompt && i.prompt.trim());
    if (!interesting) continue;
    entries.push({
      kind: "IVR",
      key: "ivr:" + num,
      title: i.name || ("IVR " + num),
      sub: "IVR " + num + (i.options.length ? " · " + i.options.length + " options" : ""),
    });
  }
  for (const num of Object.keys(data.ring_groups).sort()) {
    const r = data.ring_groups[num];
    entries.push({
      kind: "RingGroup",
      key: "rg:" + num,
      title: r.name || ("Ring group " + num),
      sub: "RG " + num + " · " + r.members.length + " member(s)",
    });
  }
  for (const num of Object.keys(data.queues).sort()) {
    const q = data.queues[num];
    entries.push({
      kind: "Queue",
      key: "queue:" + num,
      title: q.name || ("Queue " + num),
      sub: "Queue " + num + " · " + q.members.length + " agent(s)",
    });
  }
  return entries;
}

function renderSidebar(entries, activeKey, filter) {
  const container = document.getElementById('entries');
  container.innerHTML = '';
  let lastKind = null;
  const f = (filter || '').toLowerCase().trim();
  for (const e of entries) {
    if (f && !(e.title.toLowerCase().includes(f) || e.sub.toLowerCase().includes(f) ||
               e.key.toLowerCase().includes(f))) continue;
    if (e.kind !== lastKind) {
      const h = document.createElement('h2');
      h.textContent = ({Trunk:"Trunks", IVR:"IVRs (digital receptionists)",
                        RingGroup:"Ring groups", Queue:"Queues"})[e.kind] || e.kind;
      container.appendChild(h);
      lastKind = e.kind;
    }
    const a = document.createElement('a');
    a.className = 'row' + (e.key === activeKey ? ' active' : '');
    a.href = '#' + e.key;
    a.innerHTML = '<div class="num"></div><div class="sub"></div>';
    a.firstChild.textContent = e.title;
    a.lastChild.textContent = e.sub;
    a.onclick = (ev) => { ev.preventDefault(); selectEntry(e.key); };
    container.appendChild(a);
  }
}

// ---- Diagram building ---------------------------------------------------
//
// Layout: simple column-based.  Each entry-point view has at most 4 columns.
// Nodes are positioned manually so layout is predictable.

const COL_W = 200, COL_GAP = 60, ROW_H = 56, ROW_GAP = 14, PAD = 16;
const COL_X = i => PAD + i * (COL_W + COL_GAP);

function makeSvg(width, height) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  // Arrow marker
  const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = '<marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" ' +
    'markerWidth="5" markerHeight="5" orient="auto-start-reverse">' +
    '<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" ' +
    'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker>';
  svg.appendChild(defs);
  return svg;
}

function drawNode(svg, x, y, label, sub, kind, onClick) {
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  if (onClick) {
    g.style.cursor = "pointer";
    g.addEventListener("click", onClick);
  }
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("class", "node-rect");
  rect.setAttribute("x", x); rect.setAttribute("y", y);
  rect.setAttribute("width", COL_W); rect.setAttribute("height", ROW_H);
  rect.setAttribute("rx", 6);
  rect.setAttribute("fill", "var(--panel)");
  rect.setAttribute("stroke", colorFor(kind));
  rect.setAttribute("stroke-width", "1.2");
  g.appendChild(rect);
  // Color stripe on left
  const stripe = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  stripe.setAttribute("x", x); stripe.setAttribute("y", y);
  stripe.setAttribute("width", 4); stripe.setAttribute("height", ROW_H);
  stripe.setAttribute("rx", 2);
  stripe.setAttribute("fill", colorFor(kind));
  g.appendChild(stripe);
  const t1 = document.createElementNS("http://www.w3.org/2000/svg", "text");
  t1.setAttribute("class", "node-label-title");
  t1.setAttribute("x", x + 14); t1.setAttribute("y", y + 22);
  t1.setAttribute("fill", "var(--fg)");
  t1.textContent = truncate(label, 24);
  g.appendChild(t1);
  if (sub) {
    const t2 = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t2.setAttribute("class", "node-label-sub");
    t2.setAttribute("x", x + 14); t2.setAttribute("y", y + 40);
    t2.setAttribute("fill", "var(--muted)");
    t2.textContent = truncate(sub, 26);
    g.appendChild(t2);
  }
  svg.appendChild(g);
  return { x, y, w: COL_W, h: ROW_H };
}

function truncate(s, n) {
  s = s || "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function drawEdge(svg, from, to, label, dashed, labelY) {
  const x1 = from.x + from.w, y1 = from.y + from.h / 2;
  const x2 = to.x, y2 = to.y + to.h / 2;
  const mx = (x1 + x2) / 2;
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("class", "edge" + (dashed ? " dashed" : ""));
  path.setAttribute("d", `M ${x1} ${y1} C ${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`);
  // Set stroke/fill explicitly so the SVG works standalone (e.g. when copied
  // out of the page) and so cairosvg/pdf converters render it correctly.
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "var(--muted)");
  path.setAttribute("stroke-width", "1.2");
  if (dashed) path.setAttribute("stroke-dasharray", "4 3");
  path.setAttribute("marker-end", "url(#arr)");
  svg.appendChild(path);
  if (label && labelY != null) {
    // Place label in the dedicated strip above row 0, at the column-gap
    // midpoint. The caller assigns labelY to avoid same-gap collisions.
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("class", "edge-label");
    t.setAttribute("x", mx);
    t.setAttribute("y", labelY);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", "var(--muted)");
    t.textContent = label;
    svg.appendChild(t);
  }
}

// ---- Per-entry view builders -------------------------------------------

function viewTrunk(num) {
  const t = data.trunks.find(x => x.number === num);
  if (!t) return null;
  // Columns: [0] trunk, [1] DID rules, [2] primary destination
  const col0 = [{ label: t.name || "Trunk " + t.number, sub: "Trunk " + t.number,
                  kind: "Trunk" }];
  const col1 = t.rules.map((r, i) => ({
    label: r.condition === "ForwardAll" ? "Catch-all" : (r.match || r.rule_name || "rule"),
    sub: r.rule_name && r.condition !== "ForwardAll" ? r.rule_name : r.condition,
    kind: "DID",
    rule: r,
    idx: i,
  }));
  // For each rule, the office-hours dest (primary).  Out-of-hours and
  // holiday dests appear as secondary edges only when they differ.
  const destByRule = col1.map(c => destLabel(c.rule.office));
  // Dedup column 2 — many rules can share the same destination.
  const destKeys = new Map();
  const col2 = [];
  destByRule.forEach((d, i) => {
    if (!d) return;
    const key = d.kind + ":" + (d.dn || d.label);
    if (!destKeys.has(key)) {
      destKeys.set(key, col2.length);
      col2.push(d);
    }
  });
  // Out-of-hours / holiday alternates
  const altDests = []; // {ruleIdx, label, dest}
  col1.forEach((c, i) => {
    const office = c.rule.office;
    for (const [k, dest] of [["out-of-hours", c.rule.out_of_hours],
                             ["holidays", c.rule.holidays]]) {
      if (!dest) continue;
      if (office && dest.kind === office.kind && dest.dn === office.dn) continue;
      altDests.push({ruleIdx: i, label: k, dest: destLabel(dest)});
    }
  });
  const altKeys = new Map();
  const col3 = [];
  altDests.forEach(a => {
    if (!a.dest) return;
    const key = a.dest.kind + ":" + (a.dest.dn || a.dest.label);
    if (!altKeys.has(key)) { altKeys.set(key, col3.length); col3.push(a.dest); }
  });

  return { columns: [col0, col1, col2, col3],
           headers: ["Trunk", "DID match", "Routes to", "Exception"],
           edges: buildTrunkEdges(col1, destByRule, destKeys, altDests, altKeys) };
}

function buildTrunkEdges(col1, destByRule, destKeys, altDests, altKeys) {
  const edges = [];
  // trunk -> each rule
  col1.forEach((c, i) => edges.push({from:[0,0], to:[1,i]}));
  // each rule -> its primary dest
  destByRule.forEach((d, i) => {
    if (!d) return;
    const key = d.kind + ":" + (d.dn || d.label);
    edges.push({from:[1,i], to:[2, destKeys.get(key)]});
  });
  // each alt -> col3
  altDests.forEach(a => {
    if (!a.dest) return;
    const key = a.dest.kind + ":" + (a.dest.dn || a.dest.label);
    edges.push({from:[1,a.ruleIdx], to:[3, altKeys.get(key)],
                label:a.label, dashed:true});
  });
  return edges;
}

function viewIVR(num) {
  const i = data.ivrs[num];
  if (!i) return null;
  const col0 = [{ label: i.name || "IVR " + num, sub: "IVR " + num + " · " + (i.prompt || "no prompt"),
                  kind: "IVR" }];
  const col1 = i.options.filter(o => o.forward_type).map(o => ({
    label: "Press " + o.digit, sub: "", kind: "DID", option: o,
  }));
  const dests = col1.map(c => destLabel({kind: c.option.forward_type,
                                          dn: c.option.forward_dn}));
  const destKeys = new Map();
  const col2 = [];
  dests.forEach(d => {
    if (!d) return;
    const key = d.kind + ":" + (d.dn || d.label);
    if (!destKeys.has(key)) { destKeys.set(key, col2.length); col2.push(d); }
  });
  // Time-of-day exception routes
  const exceptions = [];
  for (const [k, raw] of [["out-of-hours", i.out_of_hours_route],
                          ["break", i.break_route],
                          ["holidays", i.holidays_route]]) {
    const parsed = parseRouteString(raw);
    if (!parsed) continue;
    exceptions.push({label:k, dest: destLabel(parsed)});
  }
  // Timeout behaviour
  if (i.on_timeout && i.on_timeout !== "RepeatPrompt" && i.on_timeout !== "EndCall") {
    // not common; treat as exception too
  }
  // Group exceptions by destination — multiple exception types pointing at
  // the same destination should produce one edge with a combined label
  // (e.g. "out-of-hours / break" → VM 1000) rather than overlapping edges.
  const exByDest = new Map();
  exceptions.forEach(e => {
    if (!e.dest) return;
    const key = e.dest.kind + ":" + (e.dest.dn || e.dest.label);
    if (!exByDest.has(key)) exByDest.set(key, {dest: e.dest, labels: []});
    exByDest.get(key).labels.push(e.label);
  });
  const exKeys = new Map();
  const col3 = [];
  for (const [key, v] of exByDest) {
    exKeys.set(key, col3.length);
    col3.push(v.dest);
  }

  const edges = [];
  col1.forEach((c, j) => edges.push({from:[0,0], to:[1,j]}));
  dests.forEach((d, j) => {
    if (!d) return;
    const key = d.kind + ":" + (d.dn || d.label);
    edges.push({from:[1,j], to:[2, destKeys.get(key)]});
  });
  exceptions.forEach(e => {
    if (!e.dest) return;
    const key = e.dest.kind + ":" + (e.dest.dn || e.dest.label);
    // Skip if we already drew an edge for this destination — the label
    // already includes all the exception types.
    // (Using a separate seen set so we draw exactly one combined edge.)
  });
  // Draw one combined edge per unique exception destination.
  const drawnExceptionDests = new Set();
  exceptions.forEach(e => {
    if (!e.dest) return;
    const key = e.dest.kind + ":" + (e.dest.dn || e.dest.label);
    if (drawnExceptionDests.has(key)) return;
    drawnExceptionDests.add(key);
    const labels = exByDest.get(key).labels;
    edges.push({from:[0,0], to:[3, exKeys.get(key)],
                label: labels.join(" / "), dashed:true});
  });

  return { columns: [col0, col1, col2, col3],
           headers: ["IVR", "Menu key", "Routes to", "Exception"],
           edges };
}

function viewRingGroup(num) {
  const rg = data.ring_groups[num];
  if (!rg) return null;
  const col0 = [{ label: rg.name || "Ring group " + num,
                  sub: "RG " + num + " · " + rg.strategy + " · " + rg.ring_time + "s",
                  kind: "RingGroup" }];
  // Collapse very-large member lists into a summary node — the full list
  // is in the detail table below the diagram. Threshold is 8: above that
  // the diagram becomes a wall of names that adds no information.
  let col1;
  if (rg.members.length > 8) {
    col1 = [{ label: rg.members.length + " members",
              sub: "see table below",
              kind: "Extension" }];
  } else {
    col1 = rg.members.map(m => {
      const ext = data.extensions[m];
      return { label: "Ext " + m, sub: ext ? ext.display : "", kind: "Extension",
               dn: m };
    });
  }
  const col2 = [];
  if (rg.no_answer_dest) {
    const d = destLabel(rg.no_answer_dest);
    if (d) col2.push(d);
  }
  const edges = [];
  col1.forEach((c, j) => edges.push({from:[0,0], to:[1,j]}));
  if (col2.length) edges.push({from:[0,0], to:[2,0], label:"no answer", dashed:true});
  return { columns: [col0, col1, col2],
           headers: ["Ring group", "Members", "On no-answer"],
           edges };
}

function viewQueue(num) {
  const q = data.queues[num];
  if (!q) return null;
  const col0 = [{ label: q.name || "Queue " + num,
                  sub: "Queue " + num + " · " + q.polling + " · " + q.members.length + " agents",
                  kind: "Queue" }];
  let col1;
  if (q.members.length > 8) {
    col1 = [{ label: q.members.length + " agents",
              sub: "see table below",
              kind: "Extension" }];
  } else {
    col1 = q.members.map(m => {
      const ext = data.extensions[m];
      return { label: "Ext " + m, sub: ext ? ext.display : "", kind: "Extension",
               dn: m };
    });
  }
  const col2 = [];
  if (q.timeout_dest) {
    const d = destLabel(q.timeout_dest);
    if (d) col2.push(d);
  }
  const edges = [];
  col1.forEach((c, j) => edges.push({from:[0,0], to:[1,j]}));
  if (col2.length) edges.push({from:[0,0], to:[2,0],
                                label:"timeout (" + q.master_timeout + "s)",
                                dashed:true});
  return { columns: [col0, col1, col2],
           headers: ["Queue", "Agents", "On timeout"],
           edges };
}

// ---- Renderer -----------------------------------------------------------

function renderView(view) {
  const container = document.getElementById('diagram');
  container.innerHTML = '';
  if (!view) {
    container.innerHTML = '<div class="empty">Pick an entry on the left.</div>';
    return;
  }
  // Only keep columns that have content; track each column's header.
  const allHeaders = view.headers || ["Entry", "", "", ""];
  const cols = [];
  const headers = [];
  view.columns.forEach((c, i) => {
    if (c.length > 0) { cols.push(c); headers.push(allHeaders[i] || ""); }
  });
  const maxRows = Math.max(...cols.map(c => c.length));
  // If any edge has a label, we need extra top padding so the label can
  // sit above the first row of nodes without colliding with the headers.
  const hasLabels = view.edges.some(e => e.label);
  const headerStrip = 16;            // for column headers
  const labelStrip = hasLabels ? 22 : 0;  // for edge labels above row 0
  const topPad = headerStrip + labelStrip + 8;
  const width = PAD * 2 + cols.length * COL_W + (cols.length - 1) * COL_GAP;
  const height = topPad + PAD + maxRows * ROW_H + (maxRows - 1) * ROW_GAP;
  const svg = makeSvg(width, height);

  // Column headers
  const headerY = 12;
  cols.forEach((_, i) => {
    if (!headers[i]) return;
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("class", "edge-label");
    t.setAttribute("x", COL_X(i));
    t.setAttribute("y", headerY);
    t.setAttribute("fill", "var(--muted)");
    t.textContent = headers[i];
    svg.appendChild(t);
  });

  // Position nodes
  const positioned = cols.map((col, ci) =>
    col.map((node, ri) => {
      const x = COL_X(ci);
      const y = topPad + ri * (ROW_H + ROW_GAP);
      const onClick = makeClickHandler(node);
      const pos = drawNode(svg, x, y, node.label, node.sub, node.kind, onClick);
      return pos;
    })
  );

  // Re-map original column indices (pre-filter) onto positioned indices.
  // We filtered out empty columns but kept the original `view.columns`
  // indices in `view.edges`.  Build a map from original col index ->
  // positioned col index.
  const origToPos = [];
  let pi = 0;
  view.columns.forEach((c, oi) => {
    if (c.length > 0) { origToPos[oi] = pi++; } else { origToPos[oi] = -1; }
  });

  // Track used label positions (column-gap x → next free y) so multiple
  // labels in the same gap stack vertically instead of overlapping.
  const labelStripY = headerStrip + 8;  // baseline of first label
  const usedLabelSlots = new Map();     // gap-x → array of used (y) baselines

  view.edges.forEach(e => {
    const fc = origToPos[e.from[0]], fr = e.from[1];
    const tc = origToPos[e.to[0]], tr = e.to[1];
    if (fc < 0 || tc < 0) return;
    const from = positioned[fc][fr];
    const to = positioned[tc][tr];
    if (!from || !to) return;
    let labelY = null;
    if (e.label) {
      const gapX = (from.x + from.w + to.x) / 2;
      const slot = usedLabelSlots.get(gapX) || [];
      labelY = labelStripY + slot.length * 14;  // 14px line height
      slot.push(labelY);
      usedLabelSlots.set(gapX, slot);
    }
    drawEdge(svg, from, to, e.label, e.dashed, labelY);
  });

  container.appendChild(svg);
}

function makeClickHandler(node) {
  if (node.kind === "IVR" && node.dn) return () => selectEntry("ivr:" + node.dn);
  if (node.kind === "RingGroup" && node.dn) return () => selectEntry("rg:" + node.dn);
  if (node.kind === "Queue" && node.dn) return () => selectEntry("queue:" + node.dn);
  return null;
}

// ---- Detail tables under the diagram -----------------------------------

function renderDetails(key) {
  const out = document.getElementById('details');
  out.innerHTML = '';
  const [type, num] = key.split(':');
  if (type === 'trunk') renderTrunkDetails(out, num);
  else if (type === 'ivr') renderIVRDetails(out, num);
  else if (type === 'rg') renderRGDetails(out, num);
  else if (type === 'queue') renderQueueDetails(out, num);
}

function tableRow(cells) {
  const tr = document.createElement('tr');
  cells.forEach(c => {
    const td = document.createElement('td');
    if (c instanceof Node) td.appendChild(c); else td.textContent = c == null ? '' : String(c);
    tr.appendChild(td);
  });
  return tr;
}
function tableHead(cells) {
  const tr = document.createElement('tr');
  cells.forEach(c => { const th = document.createElement('th'); th.textContent = c; tr.appendChild(th); });
  return tr;
}
function destToCell(dest) {
  const d = destLabel(dest);
  if (!d) return '—';
  const span = document.createElement('span');
  span.textContent = d.label + (d.sub ? ' (' + d.sub + ')' : '');
  if (d.kind === 'IVR' || d.kind === 'RingGroup' || d.kind === 'Queue') {
    span.style.cursor = 'pointer';
    span.style.textDecoration = 'underline';
    span.style.textDecorationStyle = 'dotted';
    span.onclick = () => selectEntry(
      (d.kind === 'IVR' ? 'ivr:' : d.kind === 'RingGroup' ? 'rg:' : 'queue:') + d.dn);
  }
  return span;
}

function section(title) {
  const wrap = document.createElement('div');
  wrap.className = 'details';
  const h = document.createElement('h3');
  h.textContent = title;
  wrap.appendChild(h);
  return wrap;
}

function renderTrunkDetails(out, num) {
  const t = data.trunks.find(x => x.number === num);
  if (!t) return;
  const sec = section('DID rules — ' + (t.name || 'Trunk ' + num));
  const tbl = document.createElement('table');
  tbl.appendChild(tableHead(['Match', 'Type', 'Office hrs', 'Out-of-hrs', 'Holidays']));
  const tbody = document.createElement('tbody');
  t.rules.forEach(r => {
    tbody.appendChild(tableRow([
      r.match || '(any — ForwardAll)',
      r.condition,
      destToCell(r.office),
      destToCell(r.out_of_hours),
      destToCell(r.holidays),
    ]));
  });
  tbl.appendChild(tbody);
  sec.appendChild(tbl);
  out.appendChild(sec);
  if (t.dids.length) {
    const dids = document.createElement('div');
    dids.className = 'details';
    dids.style.marginTop = '12px';
    dids.innerHTML = '<h3>Configured DIDs</h3><div>' +
      t.dids.map(d => '<code>' + d + '</code>').join(', ') + '</div>';
    out.appendChild(dids);
  }
}

function renderIVRDetails(out, num) {
  const i = data.ivrs[num];
  if (!i) return;
  const sec = section('Menu options — ' + (i.name || 'IVR ' + num));
  if (!i.options.length) {
    sec.innerHTML += '<div class="empty">No menu options configured (prompt-only IVR).</div>';
  } else {
    const tbl = document.createElement('table');
    tbl.appendChild(tableHead(['Press', 'Type', 'Destination']));
    const tbody = document.createElement('tbody');
    i.options.forEach(o => {
      tbody.appendChild(tableRow([
        o.digit, o.forward_type,
        destToCell({kind: o.forward_type, dn: o.forward_dn}),
      ]));
    });
    tbl.appendChild(tbody);
    sec.appendChild(tbl);
  }
  // Timeout / exception routes
  const meta = document.createElement('div');
  meta.style.marginTop = '12px';
  meta.style.color = 'var(--muted)';
  meta.style.fontSize = '12px';
  meta.innerHTML = 'Prompt: <code>' + (i.prompt || '(none)') + '</code> · ' +
    'Timeout: ' + i.timeout + 's → ' + i.on_timeout;
  sec.appendChild(meta);
  out.appendChild(sec);
}

function renderRGDetails(out, num) {
  const rg = data.ring_groups[num];
  if (!rg) return;
  const sec = section('Members — ' + (rg.name || 'Ring group ' + num));
  if (!rg.members.length) {
    sec.innerHTML += '<div class="empty">No members.</div>';
  } else {
    const tbl = document.createElement('table');
    tbl.appendChild(tableHead(['Extension', 'Name', 'Enabled']));
    const tbody = document.createElement('tbody');
    rg.members.forEach(m => {
      const e = data.extensions[m];
      tbody.appendChild(tableRow([m, e ? e.display : '(unknown)',
                                   e ? (e.enabled ? 'yes' : 'no') : '?']));
    });
    tbl.appendChild(tbody);
    sec.appendChild(tbl);
  }
  const meta = document.createElement('div');
  meta.style.marginTop = '12px';
  meta.style.color = 'var(--muted)';
  meta.style.fontSize = '12px';
  meta.textContent = 'Strategy: ' + rg.strategy + ' · Ring time: ' + rg.ring_time + 's';
  sec.appendChild(meta);
  out.appendChild(sec);
}

function renderQueueDetails(out, num) {
  const q = data.queues[num];
  if (!q) return;
  const sec = section('Agents — ' + (q.name || 'Queue ' + num));
  if (!q.members.length) {
    sec.innerHTML += '<div class="empty">No agents.</div>';
  } else {
    const tbl = document.createElement('table');
    tbl.appendChild(tableHead(['Extension', 'Name', 'Enabled']));
    const tbody = document.createElement('tbody');
    q.members.forEach(m => {
      const e = data.extensions[m];
      tbody.appendChild(tableRow([m, e ? e.display : '(unknown)',
                                   e ? (e.enabled ? 'yes' : 'no') : '?']));
    });
    tbl.appendChild(tbody);
    sec.appendChild(tbl);
  }
  const meta = document.createElement('div');
  meta.style.marginTop = '12px';
  meta.style.color = 'var(--muted)';
  meta.style.fontSize = '12px';
  meta.innerHTML = 'Polling: ' + q.polling +
    ' · Ring timeout: ' + q.ring_timeout + 's' +
    ' · Master timeout: ' + q.master_timeout + 's' +
    (q.intro_file ? ' · Intro: <code>' + q.intro_file + '</code>' : '') +
    (q.on_hold_file ? ' · Hold: <code>' + q.on_hold_file + '</code>' : '');
  sec.appendChild(meta);
  out.appendChild(sec);
}

// ---- Top-level state ----------------------------------------------------

const allEntries = buildEntries();
let activeKey = null;
let filterValue = '';

function selectEntry(key) {
  activeKey = key;
  try { history.replaceState(null, '', '#' + key); } catch (e) { /* jsdom etc. */ }
  const [type, num] = key.split(':');
  let view = null;
  if (type === 'trunk') view = viewTrunk(num);
  else if (type === 'ivr') view = viewIVR(num);
  else if (type === 'rg') view = viewRingGroup(num);
  else if (type === 'queue') view = viewQueue(num);
  renderView(view);
  renderDetails(key);
  renderSidebar(allEntries, activeKey, filterValue);
}

document.getElementById('filter').addEventListener('input', e => {
  filterValue = e.target.value;
  renderSidebar(allEntries, activeKey, filterValue);
});

// Stats
document.getElementById('stats').innerHTML =
  '<span><strong>' + data.trunks.length + '</strong> trunks</span>' +
  '<span><strong>' + Object.keys(data.ivrs).length + '</strong> IVRs</span>' +
  '<span><strong>' + Object.keys(data.ring_groups).length + '</strong> ring groups</span>' +
  '<span><strong>' + Object.keys(data.queues).length + '</strong> queues</span>' +
  '<span><strong>' + Object.keys(data.extensions).length + '</strong> extensions</span>';

// Initial render
renderSidebar(allEntries, null, '');
const initial = (location.hash || '').slice(1) ||
  (allEntries.length ? allEntries[0].key : null);
if (initial) selectEntry(initial);
else document.getElementById('diagram').innerHTML =
  '<div class="empty">No entry points found in this backup.</div>';
</script>
</body>
</html>
"""


def render_html(system: System, source_name: str) -> str:
    payload = system_to_json(system)
    # Use placeholder substitution rather than .format() to avoid CSS/JS
    # brace conflicts.
    return (HTML_TEMPLATE
            .replace("__SOURCE__", html.escape(source_name))
            .replace("__DATA__", payload))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("backup", type=Path, help="Path to a 3CX backup .zip file")
    p.add_argument("-o", "--output", type=Path,
                   help="Output HTML path (default: alongside the input)")
    p.add_argument("--mermaid-only", action="store_true",
                   help="Emit raw Mermaid source to stdout instead of HTML")
    args = p.parse_args(argv)

    if not args.backup.exists():
        print(f"error: {args.backup} not found", file=sys.stderr)
        return 1

    system = load_backup(args.backup)

    if args.mermaid_only:
        sys.stdout.write(build_mermaid(system))
        sys.stdout.write("\n")
        return 0

    out_path = args.output or args.backup.with_suffix(".routing.html")
    out_path.write_text(render_html(system, args.backup.name), encoding="utf-8")
    print(f"Wrote {out_path}")
    print(f"  trunks={len(system.trunks)} ivrs={len(system.ivrs)} "
          f"rg={len(system.ring_groups)} queues={len(system.queues)} "
          f"ext={len(system.extensions)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
