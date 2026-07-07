"""Skill loader — each concierge specialist is a self-contained folder under `skills/<name>/`:

    skills/calendar_agent/SKILL.md   ← YAML-ish frontmatter (description, tools, optional guards) + persona body

The loader parses each SKILL.md into a `Skill` (name = folder name), appending the shared SAFETY footer
(and EXTERNAL_CONTENT_GUARD for skills that read stored external content). `build_root_agent` (agent.py)
loops over `SKILLS` to construct the specialists — so adding a specialist is dropping in one folder, and the
whole thing is model-agnostic (the model is injected at build time). Dependency-free frontmatter parsing
(no pyyaml) for our small controlled schema: `key: value`, with `[a, b, c]` for list values.
"""
from dataclasses import dataclass
from pathlib import Path

from .. import safety

SKILLS_DIR = Path(__file__).resolve().parent


@dataclass(frozen=True)
class Skill:
    name: str            # == the ADK sub-agent name (folder name), e.g. "calendar_agent"
    description: str     # one line the root router picks on
    tools: tuple[str, ...]  # the MCP tool_filter slice — the ONLY tools this specialist can call
    instruction: str     # persona body + the shared safety footer(s)


def _parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split '---\\n<frontmatter>\\n---\\n<body>' → (meta dict, body). List values look like [a, b, c]."""
    if not text.startswith("---"):
        raise ValueError("SKILL.md must open with a --- frontmatter block")
    _, fm, body = text.split("---", 2)
    meta: dict = {}
    for line in fm.strip().splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if v.startswith("[") and v.endswith("]"):
            meta[k] = [x.strip() for x in v[1:-1].split(",") if x.strip()]
        else:
            meta[k] = v
    return meta, body.strip()


def load_skills() -> dict[str, Skill]:
    skills: dict[str, Skill] = {}
    for d in sorted(SKILLS_DIR.iterdir()):
        md = d / "SKILL.md"
        if not d.is_dir() or not md.exists():
            continue
        meta, body = _parse_frontmatter(md.read_text(encoding="utf-8"))
        guard = safety.EXTERNAL_CONTENT_GUARD if "external_content" in meta.get("guards", []) else ""
        skills[d.name] = Skill(
            name=d.name,
            description=meta["description"],
            tools=tuple(meta.get("tools", [])),
            instruction=body + "\n" + guard + safety.SAFETY,
        )
    return skills


SKILLS: dict[str, Skill] = load_skills()
