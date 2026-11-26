"""Local data-only character package CLI, also used by Companion's import action."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I leaves the script's folder off the path
from character_library import Library, Package, PackageError, need
import resource_store


def compose(sources, default, output):
    output = Path(output)
    need(not output.is_symlink(), "output_already_exists")
    if output.exists():
        need(output.is_dir() and not any(output.iterdir()), "output_already_exists")
        output.rmdir()
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".compose-", dir=output.parent))
    try:
        def copy_payload_file(source, destination):
            resource_store.link_or_copy(source, destination)
            shutil.copymode(source, destination)
        packages = []
        for source in sources:
            package = Package(source)
            need(not any(path.is_symlink() for path in package.root.rglob("*")), "runtime_symlink")
            destination = stage / "packages" / package.id / package.sha256
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(package.root, destination, copy_function=copy_payload_file)
            packages.append(Package(destination, deep=False))
        snapshot = Library(stage).publish(packages, default=default)
        stage.rename(output)
        return snapshot
    finally:
        if stage.exists(): shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("install", "validate", "export"):
        sub = commands.add_parser(name); sub.add_argument("source", type=Path)
        if name == "install":
            sub.add_argument("--library", type=Path, required=True)
            sub.add_argument("--validate-with", type=Path)
        if name == "export": sub.add_argument("--output", type=Path, required=True)
    sub = commands.add_parser("list"); sub.add_argument("--library", type=Path, required=True)
    sub = commands.add_parser("compose")
    sub.add_argument("--package", type=Path, action="append", default=[])
    sub.add_argument("--default")
    sub.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "install":
            need(args.validate_with is not None, "load_failed: host executable is not configured")
            library = Library(args.library)
            doc = library.import_path(args.source, validate_with=args.validate_with,
                                      progress=lambda stage, fraction: print(json.dumps(dict(event="progress", stage=stage, fraction=fraction)), flush=True))
            result = dict(revision=doc["revision"], ids=[x["id"] for x in doc["characters"]])
        elif args.command == "compose":
            doc = compose(args.package, args.default, args.output)
            result = dict(revision=doc["revision"], ids=[x["id"] for x in doc["characters"]])
        elif args.command == "list": result = Library(args.library).entries()
        elif args.command == "export":
            from character_library import export_package
            from outfit_tool import imported, strip
            # A mod's appearance stays on this machine: the export is a stripped copy.
            stripped = imported(Package(args.source))
            if stripped:
                with tempfile.TemporaryDirectory(prefix="endfield-export-") as temporary:
                    export_package(strip(args.source, Path(temporary) / "package", stripped, bump=False).root, args.output)
            else: export_package(args.source, args.output)
            result = dict(file=str(args.output), stripped_appearances=stripped)
        else:
            package = Package(args.source); result = dict(id=package.id, sha256=package.sha256, capabilities=package.document["capabilities"])
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (PackageError, OSError, ValueError) as error:
        print(str(error), file=sys.stderr); return 2


if __name__ == "__main__": sys.exit(main())
