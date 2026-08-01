import json
from pathlib import Path

import pandas as pd
import streamlit as st


ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"


@st.cache_data
def load_json(name):
    with (DATA / name).open("r", encoding="utf-8") as f:
        return json.load(f)


@st.cache_data
def load_satellites():
    by_country = load_json("by-country.json")
    meta = load_json("meta.json")

    category_labels = {c["id"]: c["label"] for c in meta.get("categories", [])}
    country_labels = {c["id"]: c["label"] for c in meta.get("countries", [])}

    rows = []
    seen = set()
    for country in by_country.get("countries", {}).values():
        for sat in country.get("sats", []):
            norad = sat.get("norad")
            if norad in seen:
                continue
            seen.add(norad)
            category_id = sat.get("cat") or "unknown"
            country_id = sat.get("country") or country.get("id") or "unknown"
            rows.append(
                {
                    "norad": int(norad),
                    "satellite": sat.get("name") or f"NORAD {norad}",
                    "purpose": category_labels.get(category_id, category_id),
                    "purpose_id": category_id,
                    "satellite_type": sat.get("orbit") or "Unknown",
                    "country": country_labels.get(country_id, country_id),
                    "country_id": country_id,
                    "company": sat.get("operator") or "Unknown",
                    "has_dossier": bool(sat.get("dossier")),
                }
            )
    return pd.DataFrame(rows)


@st.cache_data
def load_links():
    report = load_json("profile-link-check.json")
    rows = []
    for status_group in ("working", "broken"):
        for link in report.get(status_group, []):
            for occurrence in link.get("occurrences", []):
                rows.append(
                    {
                        "url": link.get("url"),
                        "works": bool(link.get("works")),
                        "link_status": "Working" if link.get("works") else "Not working",
                        "http_status": link.get("status"),
                        "method": link.get("method"),
                        "final_url": link.get("finalUrl"),
                        "error": link.get("error"),
                        "data_source": occurrence.get("provider") or "unknown",
                        "field": occurrence.get("field"),
                        "link_label": occurrence.get("label"),
                        "norad": int(occurrence["norad"]) if occurrence.get("norad") is not None else None,
                        "occurrence_satellite": occurrence.get("satellite"),
                    }
                )
    return pd.DataFrame(rows), report


def count_table(df, column, label, limit=15):
    if df.empty:
        return pd.DataFrame(columns=[label, "Links"])
    return (
        df[column]
        .fillna("Unknown")
        .value_counts()
        .rename_axis(label)
        .reset_index(name="Links")
        .head(limit)
    )


def status_table(df, column, label, limit=15):
    if df.empty:
        return pd.DataFrame(columns=[label, "Working", "Not working"])
    pivot = (
        df.pivot_table(
            index=column,
            columns="link_status",
            values="url",
            aggfunc="count",
            fill_value=0,
        )
        .reset_index()
        .rename(columns={column: label})
    )
    for col in ("Working", "Not working"):
        if col not in pivot:
            pivot[col] = 0
    pivot["Total"] = pivot["Working"] + pivot["Not working"]
    return pivot.sort_values(["Not working", "Total"], ascending=False).head(limit)


def bar_chart(df, x, y):
    if df.empty:
        st.info("No data for this selection.")
        return
    st.bar_chart(df.set_index(x)[y])


def stacked_status_chart(df, label_col):
    if df.empty:
        st.info("No data for this selection.")
        return
    chart = df.set_index(label_col)[["Working", "Not working"]]
    st.bar_chart(chart)


st.set_page_config(page_title="Satellite Profile Link Dashboard", layout="wide")

satellites = load_satellites()
links, report = load_links()
joined = links.merge(satellites, on="norad", how="left", suffixes=("", "_catalog"))
joined["satellite"] = joined["satellite"].fillna(joined["occurrence_satellite"]).fillna("Unknown")
for column in ["purpose", "satellite_type", "country", "company"]:
    joined[column] = joined[column].fillna("Unknown")
joined["data_source"] = joined["data_source"].fillna("unknown").str.upper()
joined["http_status_display"] = (
    joined["http_status"]
    .where(joined["http_status"].notna(), joined["error"])
    .fillna("Unknown")
    .astype(str)
)

st.title("Satellite Profile Link Dashboard")
st.caption(f"Generated from data/profile-link-check.json on {report.get('generated', 'unknown date')}")

with st.sidebar:
    st.header("Filters")
    status_filter = st.multiselect(
        "Link status",
        ["Working", "Not working"],
        default=["Working", "Not working"],
    )
    source_filter = st.multiselect(
        "Data source",
        sorted(joined["data_source"].dropna().unique()),
        default=sorted(joined["data_source"].dropna().unique()),
    )
    purpose_filter = st.multiselect(
        "Purpose/category",
        sorted(joined["purpose"].dropna().unique()),
    )
    country_filter = st.multiselect(
        "Country",
        sorted(joined["country"].dropna().unique()),
    )
    type_filter = st.multiselect(
        "Satellite type/orbit",
        sorted(joined["satellite_type"].dropna().unique()),
    )

filtered = joined[
    joined["link_status"].isin(status_filter)
    & joined["data_source"].isin(source_filter)
]
if purpose_filter:
    filtered = filtered[filtered["purpose"].isin(purpose_filter)]
if country_filter:
    filtered = filtered[filtered["country"].isin(country_filter)]
if type_filter:
    filtered = filtered[filtered["satellite_type"].isin(type_filter)]

unique_working = filtered.loc[filtered["works"], "url"].nunique()
unique_broken = filtered.loc[~filtered["works"], "url"].nunique()
working_occurrences = int(filtered["works"].sum())
broken_occurrences = int((~filtered["works"]).sum())

metric_cols = st.columns(5)
metric_cols[0].metric("Unique links", f"{filtered['url'].nunique():,}")
metric_cols[1].metric("Working links", f"{unique_working:,}")
metric_cols[2].metric("Not working links", f"{unique_broken:,}")
metric_cols[3].metric("Working occurrences", f"{working_occurrences:,}")
metric_cols[4].metric("Not working occurrences", f"{broken_occurrences:,}")

st.subheader("Working vs Not Working")
status_counts = (
    filtered["link_status"]
    .value_counts()
    .reindex(["Working", "Not working"], fill_value=0)
    .rename_axis("Status")
    .reset_index(name="Occurrences")
)
bar_chart(status_counts, "Status", "Occurrences")

tabs = st.tabs(["Breakdowns", "Status by Dimension", "Broken Links", "Raw Data"])

with tabs[0]:
    c1, c2 = st.columns(2)
    with c1:
        st.markdown("#### Purpose/category")
        bar_chart(count_table(filtered, "purpose", "Purpose"), "Purpose", "Links")
        st.markdown("#### Satellite country")
        bar_chart(count_table(filtered, "country", "Country"), "Country", "Links")
        st.markdown("#### Data source")
        bar_chart(count_table(filtered, "data_source", "Data source"), "Data source", "Links")
    with c2:
        st.markdown("#### Satellite type/orbit")
        bar_chart(count_table(filtered, "satellite_type", "Satellite type"), "Satellite type", "Links")
        st.markdown("#### Satellite company/operator")
        bar_chart(count_table(filtered, "company", "Company", limit=20), "Company", "Links")

with tabs[1]:
    for column, label in [
        ("purpose", "Purpose"),
        ("data_source", "Data source"),
        ("satellite_type", "Satellite type"),
        ("country", "Country"),
        ("company", "Company"),
    ]:
        st.markdown(f"#### {label}")
        table = status_table(filtered, column, label, limit=20)
        stacked_status_chart(table, label)
        st.dataframe(table, width="stretch", hide_index=True)

with tabs[2]:
    broken = filtered[~filtered["works"]].copy()
    columns = [
        "satellite",
        "norad",
        "purpose",
        "data_source",
        "satellite_type",
        "country",
        "company",
        "http_status_display",
        "url",
        "final_url",
    ]
    st.dataframe(
        broken[columns].sort_values(["http_status_display", "satellite"]),
        width="stretch",
        hide_index=True,
    )

with tabs[3]:
    st.dataframe(
        filtered[
            [
                "satellite",
                "norad",
                "link_status",
                "purpose",
                "data_source",
                "satellite_type",
                "country",
                "company",
                "http_status_display",
                "url",
            ]
        ].sort_values(["link_status", "satellite"]),
        width="stretch",
        hide_index=True,
    )
