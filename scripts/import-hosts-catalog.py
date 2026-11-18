#!/usr/bin/env python3
"""Convert ZapretGUI's hosts catalog (SQLite) into the JSON used by SkipNet.

Usage:
    python scripts/import-hosts-catalog.py "D:\\Programs\\ZapretTwo\\system\\hosts_catalog.sqlite3"

The source catalog is a third-party work distributed with ZapretGUI. Only
run this for builds where you have the right to redistribute that data.
The generated file is committed as `resources/hosts-catalog.json` so the
packaged app does not need a SQLite dependency at runtime.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from collections import OrderedDict
from pathlib import Path

DEFAULT_SOURCE = r"D:\Programs\ZapretTwo\system\hosts_catalog.sqlite3"
OUTPUT = Path(__file__).resolve().parent.parent / "resources" / "hosts-catalog.json"

# SkipNet's previous hosts feature wrote these Telegram entries. They are not
# part of ZapretGUI's catalog, so keep them as a first-class service when the
# old `# --- SkipNet (Zapret) hosts ---` block is migrated.
TELEGRAM_HOSTS = [
    "my.telegram.org",
    "desktop.telegram.org",
    "macos.telegram.org",
    "oauth.telegram.org",
    "oauth.tg.dev",
    "cdn.telesco.pe",
    "cdn1.telesco.pe",
    "cdn2.telesco.pe",
    "cdn3.telesco.pe",
    "cdn4.telesco.pe",
    "cdn5.telesco.pe",
    "cdn6.telesco.pe",
    "core.telegram.org",
    "zws4.web.telegram.org",
    "vesta.web.telegram.org",
    "vesta-1.web.telegram.org",
    "venus-1.web.telegram.org",
    "telegram.me",
    "telegram.dog",
    "telegram.space",
    "telesco.pe",
    "tg.dev",
    "telegram.org",
    "t.me",
    "api.telegram.org",
    "td.telegram.org",
    "venus.web.telegram.org",
    "web.telegram.org",
    "kws2-1.web.telegram.org",
    "kws2.web.telegram.org",
    "kws4-1.web.telegram.org",
    "kws4.web.telegram.org",
    "zws2-1.web.telegram.org",
    "zws2.web.telegram.org",
    "zws4-1.web.telegram.org",
]


def ordered_unique(values):
    seen = set()
    out = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def main(source_path: str) -> int:
    source = Path(source_path)
    if not source.is_file():
        print(f"catalog not found: {source}", file=sys.stderr)
        return 1

    con = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    con.execute("PRAGMA query_only = ON")
    cur = con.cursor()

    meta = {key: value for key, value in cur.execute("SELECT key, value FROM catalog_meta")}

    # ZapretGUI stores the last address-verification timestamp in its own
    # settings database, not in the catalog. Surface it for the UI header.
    checked_at = None
    settings_db = source.parent.parent / "user" / "settings.sqlite3"
    if settings_db.is_file():
        try:
            scon = sqlite3.connect(f"file:{settings_db}?mode=ro", uri=True)
            row = scon.execute(
                "SELECT payload FROM settings_sections WHERE section = 'hosts'"
            ).fetchone()
            if row:
                checked_at = (json.loads(row[0]).get("engine") or {}).get("checked_at")
            scon.close()
        except Exception as exc:  # best-effort metadata only
            print(f"warning: could not read checked_at: {exc}", file=sys.stderr)

    profiles = [
        {
            "id": profile_id,
            "name": name,
            "order": order,
        }
        for profile_id, name, order, enabled in cur.execute(
            "SELECT profile_id, name, sort_order, enabled FROM dns_profiles "
            "WHERE enabled = 1 ORDER BY sort_order, name"
        )
    ]

    services = []
    # Materialise the outer query: reusing the same cursor for the nested
    # lookups below would reset it and abort the iteration after the first row.
    service_rows = list(
        cur.execute(
            "SELECT service_id, name, category, kind, sort_order, icon_name, icon_color "
            "FROM services WHERE enabled = 1 ORDER BY sort_order, name"
        )
    )
    inner = con.cursor()
    for (
        service_id,
        name,
        category,
        kind,
        order,
        icon,
        color,
    ) in service_rows:
        service = {
            "id": service_id,
            "name": name,
            "category": category,
            "kind": kind,
            "order": order,
            "icon": icon,
            "color": color,
        }

        if kind == "hosts":
            entries = []
            current_host = None
            current_ips = []
            # Order by hostname then priority so each hostname keeps its
            # preferred address ordering from the source catalog.
            rows = inner.execute(
                "SELECT hostname, ip_address FROM hosts_entries "
                "WHERE service_id = ? ORDER BY hostname COLLATE NOCASE, priority, entry_id",
                (service_id,),
            )
            for hostname, ip in rows:
                if hostname != current_host:
                    if current_host is not None:
                        entries.append(
                            {"hostname": current_host, "ips": ordered_unique(current_ips)}
                        )
                    current_host = hostname
                    current_ips = []
                current_ips.append(ip)
            if current_host is not None:
                entries.append({"hostname": current_host, "ips": ordered_unique(current_ips)})
            service["entries"] = entries
        else:
            domains = []
            hostnames = list(
                inner.execute(
                    "SELECT hostname FROM domains WHERE service_id = ? "
                    "ORDER BY sort_order, hostname COLLATE NOCASE",
                    (service_id,),
                )
            )
            for (hostname,) in hostnames:
                answers = OrderedDict()
                for profile_id, ip in inner.execute(
                    """
                    SELECT a.profile_id, a.ip_address
                    FROM dns_answers a
                    JOIN domains d ON d.domain_id = a.domain_id
                    WHERE d.service_id = ? AND d.hostname = ?
                    ORDER BY a.profile_id, a.priority, a.ip_address
                    """,
                    (service_id, hostname),
                ):
                    answers.setdefault(profile_id, []).append(ip)
                if not answers:
                    # Nothing resolvable for this hostname in any profile.
                    continue
                domains.append(
                    {
                        "hostname": hostname,
                        "answers": {
                            profile: ordered_unique(ips) for profile, ips in answers.items()
                        },
                    }
                )
            service["domains"] = domains

        services.append(service)

    # Synthetic service for the Telegram entries SkipNet used to manage
    # separately. Kept last so it does not disturb ZapretGUI's ordering.
    services.append(
        {
            "id": "custom.telegram",
            "name": "Telegram",
            "category": "direct",
            "kind": "hosts",
            "order": 1000,
            "icon": "fa5b.telegram",
            "color": "#26A5E4",
            "entries": [
                {"hostname": hostname, "ips": ["149.154.167.220"]}
                for hostname in TELEGRAM_HOSTS
            ],
        }
    )

    output = {
        "meta": {
            "version": meta.get("catalog_version", ""),
            "sha256": meta.get("content_sha256", ""),
            "createdAt": meta.get("created_at", ""),
            "checkedAt": checked_at or "",
            "schemaVersion": int(meta.get("schema_version", "1") or 1),
            "source": "ZapretGUI hosts_catalog.sqlite3",
        },
        "dnsProfiles": profiles,
        "services": services,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    hosts_services = sum(1 for s in services if s["kind"] == "hosts")
    dns_services = sum(1 for s in services if s["kind"] == "dns")
    print(
        f"wrote {OUTPUT} ({OUTPUT.stat().st_size} bytes): "
        f"{len(services)} services ({hosts_services} hosts, {dns_services} dns), "
        f"{len(profiles)} profiles"
    )
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE))
