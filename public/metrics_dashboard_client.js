// public/metrics_dashboard_client.js
// Renders the SSF metrics dashboard tiles from /api/metrics/data.

// Categorical palette (dark mode), fixed order — validated with the dataviz
// skill's palette validator (all six checks PASS against the dark chart
// surface #1a1a19). Never reassigned per-chart; a pool keeps the same color
// across every tile.
const CATEGORICAL_HUES = [
	"#3987e5", // blue
	"#d95926", // orange
	"#199e70", // aqua
	"#c98500", // yellow
	"#d55181", // magenta
	"#008300", // green
	"#9085e9", // violet
	"#e66767", // red
];

const TEXT_SECONDARY = "#c3c2b7";
const TEXT_MUTED = "#898781";
const GRIDLINE = "#2c2c2a";

let charts = {};
let currentHours = 168;

function poolStyle(poolId, allPoolsSorted) {
	const idx = allPoolsSorted.indexOf(poolId);
	const wraps = idx >= CATEGORICAL_HUES.length;
	return {
		color: CATEGORICAL_HUES[idx % CATEGORICAL_HUES.length],
		borderDash: wraps ? [6, 3] : [],
	};
}

function formatLabel(isoString) {
	const d = new Date(isoString);
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	const hh = String(d.getHours()).padStart(2, "0");
	const mi = String(d.getMinutes()).padStart(2, "0");
	return `${mm}/${dd} ${hh}:${mi}`;
}

function renderTile(canvas, rows, allPoolsSorted) {
	const timestamps = [...new Set(rows.map(r => r.RECORDED_AT))].sort();
	const labels = timestamps.map(formatLabel);
	const poolsInTile = [...new Set(rows.map(r => r.POOL_ID))].sort();

	const datasets = poolsInTile.map(poolId => {
		const style = poolStyle(poolId, allPoolsSorted);
		return {
			label: poolId,
			data: timestamps.map(ts => {
				const row = rows.find(r => r.RECORDED_AT === ts && r.POOL_ID === poolId);
				return row ? row.VALUE : 0;
			}),
			borderColor: style.color,
			borderDash: style.borderDash,
			backgroundColor: style.color,
			borderWidth: 2,
			pointRadius: 0,
			pointHoverRadius: 4,
			tension: 0,
			fill: false,
		};
	});

	const key = canvas.dataset.metric + ":" + canvas.dataset.dimensionValue;
	if (charts[key]) charts[key].destroy();

	charts[key] = new Chart(canvas, {
		type: "line",
		data: { labels, datasets },
		options: {
			responsive: true,
			maintainAspectRatio: false,
			interaction: { mode: "index", intersect: false },
			plugins: {
				legend: {
					position: "top",
					labels: { color: TEXT_SECONDARY, usePointStyle: true, pointStyle: "line", boxWidth: 20 },
				},
				tooltip: { mode: "index", intersect: false },
			},
			scales: {
				x: {
					ticks: { color: TEXT_MUTED, maxRotation: 0, autoSkip: true },
					grid: { color: GRIDLINE },
				},
				y: {
					beginAtZero: true,
					ticks: { color: TEXT_MUTED, precision: 0 },
					grid: { color: GRIDLINE },
				},
			},
		},
	});
}

async function loadDashboard(hours) {
	const grid = document.getElementById("grid");
	grid.classList.add("loading");

	try {
		const res = await fetch(`/api/metrics/data?hours=${hours}`);
		const rows = await res.json();
		const allPoolsSorted = [...new Set(rows.map(r => r.POOL_ID))].sort();

		document.querySelectorAll("canvas[data-metric]").forEach(canvas => {
			const metric = canvas.dataset.metric;
			const dimensionValue = canvas.dataset.dimensionValue;
			const filtered = rows.filter(r => {
				if (r.METRIC_NAME !== metric) return false;
				if (dimensionValue) return r.DIMENSION_VALUE === dimensionValue;
				return true;
			});
			renderTile(canvas, filtered, allPoolsSorted);
		});
	} finally {
		grid.classList.remove("loading");
	}
}

document.addEventListener("DOMContentLoaded", () => {
	loadDashboard(currentHours);

	document.getElementById("ranges").addEventListener("click", e => {
		const btn = e.target.closest(".range-btn");
		if (!btn) return;
		document.querySelectorAll(".range-btn").forEach(b => b.classList.remove("active"));
		btn.classList.add("active");
		currentHours = parseInt(btn.dataset.hours, 10);
		loadDashboard(currentHours);
	});
});
