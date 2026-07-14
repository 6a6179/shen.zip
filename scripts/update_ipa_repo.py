#!/usr/bin/env python3
"""Update public/repo.json from each app's authoritative upstream source.

Uses only the Python standard library. New IPA files are downloaded only when an
upstream candidate changes (or --force is passed), then the bundle metadata,
size, and SHA-256 are derived from the actual IPA before the source is changed.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import os
import plistlib
import re
import shutil
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPO_PATH = ROOT / "public" / "repo.json"
USER_AGENT = "shen.zip-ipa-source-updater/1.0"

UYOU_FEED = (
    "https://raw.githubusercontent.com/"
    "arichornlover/arichornlover.github.io/main/apps.json"
)

APP_ALIASES = {
    "uyou": "uYouEnhanced",
    "hop": "Hop",
    "flappy": "Flappy Bird",
}


@dataclasses.dataclass(frozen=True)
class Candidate:
    app_name: str
    bundle_identifier: str
    download_url: str
    date: str
    description: str
    version_hint: str | None = None
    trusted_size: int | None = None
    marketing_version: str | None = None
    release_url: str | None = None
    source_feed: str | None = None
    app_description: str | None = None


@dataclasses.dataclass(frozen=True)
class IPAMetadata:
    bundle_identifier: str
    version: str
    build_version: str
    min_os_version: str | None
    size: int
    sha256: str


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


def request(url: str, *, method: str = "GET") -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT}
    if urllib.parse.urlparse(url).hostname == "api.github.com":
        headers["Accept"] = "application/vnd.github+json"
        headers["X-GitHub-Api-Version"] = "2022-11-28"
        token = os.environ.get("GITHUB_TOKEN")
        if token:
            headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, method=method, headers=headers)


def fetch_json(url: str) -> Any:
    with urllib.request.urlopen(request(url), timeout=60) as response:
        return json.load(response)


def resolve_download_url(url: str) -> str:
    """Resolve author-controlled short links without retaining preview pages."""
    parsed = urllib.parse.urlparse(url)
    if parsed.hostname not in {"tinyurl.com", "www.tinyurl.com"}:
        return url

    opener = urllib.request.build_opener(NoRedirect)
    headers = None
    try:
        with opener.open(request(url, method="HEAD"), timeout=30) as response:
            headers = response.headers
    except urllib.error.HTTPError as error:
        if 300 <= error.code < 400:
            headers = error.headers
        else:
            raise

    if headers is None:
        raise RuntimeError(f"Could not resolve short URL: {url}")

    target = headers.get("X-TinyURL-Target")
    if target:
        return target

    location = headers.get("Location")
    if location and "/preview/download/" not in location:
        return urllib.parse.urljoin(url, location)

    raise RuntimeError(
        f"TinyURL returned a preview page without X-TinyURL-Target: {url}"
    )


def github_release_candidate(
    *,
    repo: str,
    asset_name: str,
    app_name: str,
    bundle_identifier: str,
    allow_prerelease: bool = False,
) -> Candidate:
    releases = fetch_json(f"https://api.github.com/repos/{repo}/releases?per_page=100")
    eligible: list[tuple[dict[str, Any], dict[str, Any]]] = []

    for release in releases:
        if release.get("draft") or (
            release.get("prerelease") and not allow_prerelease
        ):
            continue
        asset = next(
            (item for item in release.get("assets", []) if item.get("name") == asset_name),
            None,
        )
        if asset:
            eligible.append((release, asset))

    if not eligible:
        raise RuntimeError(f"No published {asset_name} release asset found in {repo}")

    release, asset = max(
        eligible,
        key=lambda pair: pair[0].get("published_at")
        or pair[0].get("created_at")
        or "",
    )
    tag = str(release["tag_name"])
    body = str(release.get("body") or release.get("name") or tag).strip()

    return Candidate(
        app_name=app_name,
        bundle_identifier=bundle_identifier,
        download_url=str(asset["browser_download_url"]),
        date=str(release.get("published_at") or release.get("created_at")),
        description=body[:8000],
        trusted_size=int(asset["size"]),
        marketing_version=str(release.get("name") or tag),
        release_url=str(release.get("html_url") or ""),
    )


def uyou_candidate() -> Candidate:
    feed = fetch_json(UYOU_FEED)
    app = next(
        (
            item
            for item in feed.get("apps", [])
            if item.get("bundleIdentifier") == "com.google.ios.youtube"
        ),
        None,
    )
    if app is None:
        raise RuntimeError("uYouEnhanced app not found in its official source")

    source_version = (app.get("versions") or [{}])[0]
    short_url = source_version.get("downloadURL") or app.get("downloadURL")
    if not short_url:
        raise RuntimeError("uYouEnhanced source has no download URL")

    description = str(
        source_version.get("localizedDescription")
        or app.get("versionDescription")
        or "uYouEnhanced update"
    ).strip()
    version_hint = str(source_version.get("version") or app.get("version") or "")
    date = str(
        source_version.get("date")
        or app.get("versionDate")
        or dt.datetime.now(dt.timezone.utc).isoformat()
    )

    tweak_match = re.search(
        r"Current uYou(?:Enhanced)? Version:\s*[\"'`]?v?([0-9][0-9A-Za-z.\-]+)",
        description,
        flags=re.IGNORECASE,
    )
    marketing_version = version_hint
    if tweak_match:
        marketing_version = f"{version_hint} / uYouEnhanced {tweak_match.group(1)}"

    return Candidate(
        app_name="uYouEnhanced",
        bundle_identifier="com.google.ios.youtube",
        download_url=resolve_download_url(str(short_url)),
        date=date,
        description=description[:8000],
        version_hint=version_hint or None,
        marketing_version=marketing_version or None,
        source_feed=UYOU_FEED,
        app_description=app.get("localizedDescription"),
    )


def discover_candidates(selected: set[str]) -> list[Candidate]:
    candidates: list[Candidate] = []
    if "uyou" in selected:
        candidates.append(uyou_candidate())
    if "hop" in selected:
        candidates.append(
            github_release_candidate(
                repo="6a6179/Hop",
                asset_name="Hop-unsigned.ipa",
                app_name="Hop",
                bundle_identifier="cat.string.hop",
                allow_prerelease=True,
            )
        )
    if "flappy" in selected:
        candidates.append(
            github_release_candidate(
                repo="brandonplank/flappybird",
                asset_name="org.brandonplank.flappybird.ipa",
                app_name="Flappy Bird",
                bundle_identifier="org.brandonplank.flappybird",
            )
        )
    return candidates


def inspect_ipa(url: str, destination: Path) -> IPAMetadata:
    digest = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(request(url), timeout=180) as response, destination.open(
        "wb"
    ) as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            digest.update(chunk)
            size += len(chunk)

    if not zipfile.is_zipfile(destination):
        raise RuntimeError(f"Downloaded file is not an IPA/ZIP: {url}")

    with zipfile.ZipFile(destination) as archive:
        plist_paths = [
            name
            for name in archive.namelist()
            if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)
        ]
        if len(plist_paths) != 1:
            raise RuntimeError(
                f"Expected one top-level app Info.plist, found {len(plist_paths)} in {url}"
            )
        info = plistlib.loads(archive.read(plist_paths[0]))

    required = ["CFBundleIdentifier", "CFBundleShortVersionString", "CFBundleVersion"]
    missing = [key for key in required if not info.get(key)]
    if missing:
        raise RuntimeError(f"IPA is missing required Info.plist keys: {', '.join(missing)}")

    return IPAMetadata(
        bundle_identifier=str(info["CFBundleIdentifier"]),
        version=str(info["CFBundleShortVersionString"]),
        build_version=str(info["CFBundleVersion"]),
        min_os_version=str(info["MinimumOSVersion"])
        if info.get("MinimumOSVersion")
        else None,
        size=size,
        sha256=digest.hexdigest(),
    )


def find_app(source: dict[str, Any], bundle_identifier: str) -> dict[str, Any]:
    app = next(
        (
            item
            for item in source.get("apps", [])
            if item.get("bundleIdentifier") == bundle_identifier
        ),
        None,
    )
    if app is None:
        raise RuntimeError(f"App {bundle_identifier} is missing from repo.json")
    return app


def candidate_is_current(app: dict[str, Any], candidate: Candidate) -> bool:
    current = (app.get("versions") or [{}])[0]
    if current.get("downloadURL") != candidate.download_url:
        return False
    if candidate.version_hint and str(current.get("version")) != candidate.version_hint:
        return False
    if candidate.trusted_size is not None and current.get("size") != candidate.trusted_size:
        return False
    return True


def apply_candidate(
    source: dict[str, Any], candidate: Candidate, temporary_directory: Path
) -> tuple[bool, IPAMetadata | None]:
    app = find_app(source, candidate.bundle_identifier)
    ipa_path = temporary_directory / f"{candidate.bundle_identifier}.ipa"
    metadata = inspect_ipa(candidate.download_url, ipa_path)

    if metadata.bundle_identifier != candidate.bundle_identifier:
        raise RuntimeError(
            f"Bundle ID mismatch for {candidate.app_name}: "
            f"expected {candidate.bundle_identifier}, got {metadata.bundle_identifier}"
        )
    if candidate.version_hint and metadata.version != candidate.version_hint:
        raise RuntimeError(
            f"Version mismatch for {candidate.app_name}: official source says "
            f"{candidate.version_hint}, IPA contains {metadata.version}"
        )
    if candidate.trusted_size is not None and metadata.size != candidate.trusted_size:
        raise RuntimeError(
            f"Size mismatch for {candidate.app_name}: GitHub reports "
            f"{candidate.trusted_size}, downloaded {metadata.size}"
        )

    version: dict[str, Any] = {
        "version": metadata.version,
        "buildVersion": metadata.build_version,
    }
    if candidate.marketing_version:
        version["marketingVersion"] = candidate.marketing_version
    version.update(
        {
            "date": candidate.date,
            "localizedDescription": candidate.description,
            "downloadURL": candidate.download_url,
            "size": metadata.size,
        }
    )
    if metadata.min_os_version:
        version["minOSVersion"] = metadata.min_os_version
    version["sha256"] = metadata.sha256

    previous_versions = app.get("versions") or []
    current_version = previous_versions[0] if previous_versions else None
    legacy_fields_match = (
        str(app.get("version")) == metadata.version
        and app.get("versionDate") == candidate.date
        and app.get("downloadURL") == candidate.download_url
        and app.get("size") == metadata.size
    )
    if current_version == version and legacy_fields_match:
        print(
            f"Verified {candidate.app_name}: {metadata.version} "
            f"({metadata.build_version}), SHA-256 unchanged"
        )
        return False, None

    previous_versions = [
        old
        for old in previous_versions
        if not (
            str(old.get("version")) == metadata.version
            and str(old.get("buildVersion")) == metadata.build_version
        )
    ]
    app["versions"] = [version, *previous_versions]

    # Legacy fields retained for signers that do not yet read `versions`.
    app["version"] = metadata.version
    app["versionDate"] = candidate.date
    app["versionDescription"] = candidate.description
    app["downloadURL"] = candidate.download_url
    app["size"] = metadata.size
    if candidate.app_description:
        app["localizedDescription"] = candidate.app_description

    print(
        f"Updated {candidate.app_name}: {metadata.version} "
        f"({metadata.build_version}), {metadata.size} bytes"
    )
    return True, metadata


def update_checksums(
    records: list[tuple[Candidate, IPAMetadata]], *, now: str, path: Path
) -> None:
    if not path.exists() or not records:
        return

    data = json.loads(path.read_text())
    by_name = {item.get("name"): item for item in data.get("apps", [])}
    for candidate, metadata in records:
        item = by_name.get(candidate.app_name)
        if item is None:
            item = {"name": candidate.app_name}
            data.setdefault("apps", []).append(item)
        item["downloadURL"] = candidate.download_url
        item["size"] = metadata.size
        item["sha256"] = metadata.sha256
        if candidate.release_url:
            item["release"] = candidate.release_url
        if candidate.source_feed:
            item["sourceFeed"] = candidate.source_feed
    data["generatedAt"] = now
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, default=DEFAULT_REPO_PATH)
    parser.add_argument(
        "--app",
        action="append",
        choices=sorted(APP_ALIASES),
        help="Update only this app alias; may be repeated",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Re-download and verify even when upstream metadata appears unchanged",
    )
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    repo_path = args.repo.resolve()
    source = json.loads(repo_path.read_text())
    selected = set(args.app or APP_ALIASES)
    candidates = discover_candidates(selected)
    changed = False
    updated_records: list[tuple[Candidate, IPAMetadata]] = []

    with tempfile.TemporaryDirectory(prefix="ipa-source-update-") as temporary:
        temporary_directory = Path(temporary)
        for candidate in candidates:
            app = find_app(source, candidate.bundle_identifier)
            if not args.force and candidate_is_current(app, candidate):
                print(f"Up to date: {candidate.app_name}")
                continue
            did_change, metadata = apply_candidate(source, candidate, temporary_directory)
            changed |= did_change
            if metadata:
                updated_records.append((candidate, metadata))

    if not changed:
        print("No source changes required.")
        return 0

    # Confirm serialization before replacing the source file.
    rendered = json.dumps(source, indent=2, ensure_ascii=False) + "\n"
    json.loads(rendered)
    if args.dry_run:
        print("Dry run: repo.json was not written.")
        return 0

    temporary_repo = repo_path.with_suffix(".json.tmp")
    temporary_repo.write_text(rendered)
    shutil.move(temporary_repo, repo_path)
    now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )
    site_root = repo_path.parent.parent if repo_path.parent.name == "public" else repo_path.parent
    update_checksums(updated_records, now=now, path=site_root / "checksums.json")
    print(f"Wrote {repo_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # fail closed; never commit a partial source
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
