"""Output-location policy for generated test artifacts; importing this module has no side effects."""
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4


def artifact_directory(project_root, requested=None):
    root = Path(project_root).resolve()
    if requested is None:
        run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8]
        candidate = root / "test-results" / "tui" / run_id
    else:
        candidate = Path(requested).expanduser().resolve()
    # Resolve both operands, including existing symlinks, before enforcing containment.
    candidate = candidate.resolve()
    allowed = root / "test-results"
    if candidate == root or root in candidate.parents:
        if candidate != allowed and allowed not in candidate.parents:
            raise ValueError("Generated test output inside this repository must be under test-results/, not documentation, fixtures, or source directories.")
    return candidate


def reserve_recording_directory(project_root, requested=None):
    directory = artifact_directory(project_root, requested)
    if directory.exists() and (not directory.is_dir() or any(directory.iterdir())):
        raise ValueError("The recording output directory must be new or empty. Choose a new run directory instead of overwriting evidence.")
    directory.mkdir(parents=True, exist_ok=True)
    try:
        # Reserve the run atomically so concurrent recorders cannot share an empty path.
        with (directory / "run-metadata.json").open("x") as metadata:
            metadata.write("{}\n")
    except FileExistsError as error:
        raise ValueError("This recording directory has already been reserved. Choose a new run directory.") from error
    return directory
