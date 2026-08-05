"""
eBL ATF validator CLI for cuneiform-scorer.

Reads chapter ATF text from stdin, parses each line using the eBL ATF Lark
grammar (Earley parser), and writes a JSON result to stdout.

This is the same grammar and parser BEn-app uses (server/src/services/ebl_atf_parser.py).
The Lark grammar files live in ./ebl-grammar/ relative to this script.

Designed to be PyInstaller-bundleable so the Electron desktop app can ship it
without requiring the user to have Python installed.

Output schema:
{
    "valid": bool,
    "errors": [{ "line": int (1-based), "column": int|null, "message": str }, ...],
    "warnings": [str, ...],
    "parsed_lines": int,
    "validation_source": "local_lark" | "local_basic",
    "available": bool
}

Errors are emitted in the SAME ORDER as they appear in the input. The Node
endpoint / frontend is responsible for capping at N for display.
"""

import json
import re
import sys
from pathlib import Path

# Force UTF-8 on stdio so we can faithfully receive non-ASCII ATF
# (subscripts, half-brackets, etc.) regardless of the parent shell's locale.
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Make grammar dir locatable both when run from source and from a PyInstaller bundle.
def _grammar_dir() -> Path:
    here = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
    candidates = [here / "ebl-grammar", here / "ebl_grammar"]
    for c in candidates:
        if c.exists():
            return c
    return Path(__file__).resolve().parent / "ebl-grammar"


GRAMMAR_DIR = _grammar_dir()
GRAMMAR_FILE = GRAMMAR_DIR / "ebl_atf.lark"

try:
    from lark import Lark, UnexpectedCharacters, UnexpectedToken, UnexpectedInput
    from lark.exceptions import LarkError
    _LARK_AVAILABLE = True
    _LARK_IMPORT_ERROR = None
except ImportError as e:  # pragma: no cover
    _LARK_AVAILABLE = False
    _LARK_IMPORT_ERROR = str(e)


_PARSER = None
_PARSER_INIT_ERROR = None


def _get_parser():
    """Lazy-init the Lark parser (~1s, paid once per process)."""
    global _PARSER, _PARSER_INIT_ERROR
    if _PARSER is not None or _PARSER_INIT_ERROR is not None:
        return _PARSER
    if not _LARK_AVAILABLE:
        _PARSER_INIT_ERROR = f"lark not installed: {_LARK_IMPORT_ERROR}"
        return None
    if not GRAMMAR_FILE.exists():
        _PARSER_INIT_ERROR = f"Grammar file not found at {GRAMMAR_FILE}"
        return None
    try:
        with open(GRAMMAR_FILE, "r", encoding="utf-8") as f:
            grammar = f.read()
        # "translation_line" is a second start rule because the default one is
        # too permissive for #tr rows: `control_line` matches anything opening
        # with "#", so a malformed translation would parse here and only fail
        # server-side on import. Starting at translation_line checks it for real.
        _PARSER = Lark(
            grammar,
            parser="earley",
            import_paths=[str(GRAMMAR_DIR)],
            propagate_positions=True,
            start=["start", "translation_line"],
        )
    except Exception as exc:  # pragma: no cover
        _PARSER_INIT_ERROR = f"Parser init failed: {exc}"
    return _PARSER


# Recognize the structural shape of each row in the scorer's artifact so we
# know what to feed the Lark parser.
RECON_RE = re.compile(r"^\s*\d+'?\.\s")
WITNESS_RE = re.compile(r"^\s*([^\s]+)\s+(\d+'?)\.\s+(.*)$")
TRANSLATION_RE = re.compile(r"^#tr\b")


def _parse_with_lark(parser, fragment: str, start: str = "start"):
    """Return (ok, message, column). column is 1-based or None."""
    if not fragment.strip():
        return True, None, None
    try:
        parser.parse(fragment, start=start)
        return True, None, None
    except UnexpectedCharacters as e:
        return False, f"Unexpected character '{e.char}'", e.column
    except UnexpectedToken as e:
        expected = ", ".join(e.expected) if e.expected else "unknown"
        return False, f"Unexpected token. Expected: {expected}", e.column
    except UnexpectedInput as e:
        return False, "Parse error", getattr(e, "column", None)
    except LarkError as e:
        return False, str(e), None
    except Exception as e:
        return False, f"Parse error: {e}", None


def _check_brackets(line: str):
    """Mirror BEn-app's bracket check. Returns (column, message) or (None, None).

    Uses separate stacks per bracket type so ATF interleaving is allowed
    (e.g. damage and determinative brackets are independent).
    """
    pairs = {"(": ")", "[": "]", "<": ">", "{": "}"}
    closing = {v: k for k, v in pairs.items()}
    stacks = {op: [] for op in pairs}

    for i, ch in enumerate(line):
        if ch in pairs:
            stacks[ch].append(i)
        elif ch in closing:
            opener = closing[ch]
            if stacks[opener]:
                stacks[opener].pop()
            else:
                return i + 1, "Invalid brackets."

    for positions in stacks.values():
        if positions:
            return positions[-1] + 1, "Invalid brackets."
    return None, None


def _basic_validate_line(line: str):
    """Fallback when Lark unavailable. Returns list of (column|None, message)."""
    if line.startswith(("&", "#", "@", "$", "//")):
        return []
    out = []
    for op, cl in (("[", "]"), ("(", ")"), ("<", ">"), ("{", "}")):
        if line.count(op) != line.count(cl):
            out.append((None, f"Unmatched brackets '{op}' and '{cl}'"))
    return out


def validate(atf_text: str):
    parser = _get_parser()
    errors = []
    warnings = []
    parsed_lines = 0

    # Strip BOM that some shells add when piping UTF-8 stdin.
    if atf_text.startswith("﻿"):
        atf_text = atf_text[1:]

    lines = atf_text.split("\n")
    for i, raw in enumerate(lines, start=1):
        stripped = raw.strip()
        if not stripped:
            continue
        parsed_lines += 1

        # Classify by row shape so we know what to validate.
        # - Reconstruction (`N. content`): parse the line as-is (the eBL `line`
        #   rule has a `text_line` alternative which matches this).
        # - Witness (`SIG N. content`): strip the siglum prefix and parse the
        #   resulting `N. content` as a text line. Column offsets are adjusted
        #   so error positions point at the right character in the original row.
        # - Anything else: try as-is and let Lark decide.
        col_offset = 0
        to_parse = stripped
        start = "translation_line" if TRANSLATION_RE.match(stripped) else "start"
        witness_match = WITNESS_RE.match(raw)
        if witness_match and not RECON_RE.match(raw):
            siglum, ms_line, content = witness_match.groups()
            # Recompose as a fragment-style text line for the Lark grammar.
            to_parse = f"{ms_line}. {content}"
            # Column in `to_parse` → column in original `raw`
            col_offset = raw.find(ms_line)
            if col_offset < 0:
                col_offset = 0

        if parser:
            ok, msg, col = _parse_with_lark(parser, to_parse, start)
            if not ok:
                adjusted_col = (col + col_offset) if (col is not None) else None
                errors.append({"line": i, "column": adjusted_col, "message": msg})
                continue
            # Bracket check on non-control rows (matches BEn-app's heuristic).
            if not stripped.startswith(("&", "#", "@", "$", "//")):
                bcol, bmsg = _check_brackets(stripped)
                if bmsg:
                    # Column is in the stripped row; locate it in the raw row.
                    leading = len(raw) - len(raw.lstrip())
                    errors.append({"line": i, "column": bcol + leading, "message": bmsg})
        else:
            for col, msg in _basic_validate_line(stripped):
                errors.append({"line": i, "column": col, "message": msg})

    return {
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "parsed_lines": parsed_lines,
        "validation_source": "local_lark" if parser else "local_basic",
        "available": parser is not None,
        "init_error": _PARSER_INIT_ERROR,
    }


def main():
    atf = sys.stdin.read()
    try:
        result = validate(atf)
    except Exception as exc:
        result = {
            "valid": False,
            "errors": [{"line": 1, "column": None, "message": f"Validator crashed: {exc}"}],
            "warnings": [],
            "parsed_lines": 0,
            "validation_source": "local_basic",
            "available": False,
            "init_error": str(exc),
        }
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
