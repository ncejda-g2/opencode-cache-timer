"""Render the cost-comparison chart for the README.

Two paths plotted vs. input-context size:
  A: Resume original session and pay the cold-write fee.
  B: Capture the hot auto-summary, paste it into a fresh session.

Assumptions are named constants below so the chart is easy to re-render.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

# ---- Pricing (Claude Opus 4.7, USD per million tokens) ----
PRICE_COLD_WRITE_PER_MTOK = 6.25
PRICE_HOT_READ_PER_MTOK = 0.50

# ---- Fresh-session overhead (Path B) ----
STARTUP_OVERHEAD_TOKENS = 50_000     # System prompt, AGENTS.md, MCP defs, etc.
SUMMARY_PASTE_TOKENS = 1_000         # The summary you paste into the new session
NUM_FILE_REREADS = 5                 # Number of files you re-read in the fresh session
LOC_PER_FILE_REREAD = 1_000          # Average LOC per re-read file
TOKENS_PER_LOC = 4                   # Approx tokens/LOC for source code
FILE_REREAD_TOKENS = NUM_FILE_REREADS * LOC_PER_FILE_REREAD * TOKENS_PER_LOC

FRESH_SESSION_OVERHEAD_TOKENS = (
    STARTUP_OVERHEAD_TOKENS + SUMMARY_PASTE_TOKENS + FILE_REREAD_TOKENS
)

# ---- Plot range ----
# Smallest possible "session" is just the startup overhead itself — there's
# nothing below that to resume.
X_MIN_TOKENS = STARTUP_OVERHEAD_TOKENS
X_MAX_TOKENS = 1_000_000
REFERENCE_X_TOKENS = 500_000

OUT_PATH = Path(__file__).parent.parent / "docs" / "assets" / "cost-comparison.svg"


def cost_per_mtok(tokens: float, price: float) -> float:
    return tokens * price / 1_000_000


def cost_path_a(x_tokens: np.ndarray) -> np.ndarray:
    """Path A: resume cold. Pay cold-write on the full original context."""
    return cost_per_mtok(x_tokens, PRICE_COLD_WRITE_PER_MTOK)


def cost_path_b(x_tokens: np.ndarray) -> np.ndarray:
    """Path B: hot-read summary + cold-write the (small) fresh-session overhead."""
    hot_read = cost_per_mtok(x_tokens, PRICE_HOT_READ_PER_MTOK)
    fresh_overhead = cost_per_mtok(
        FRESH_SESSION_OVERHEAD_TOKENS, PRICE_COLD_WRITE_PER_MTOK
    )
    return hot_read + fresh_overhead


def main() -> None:
    x = np.linspace(X_MIN_TOKENS, X_MAX_TOKENS, 500)
    y_a = cost_path_a(x)
    y_b = cost_path_b(x)

    # Crossover where Path A cost equals Path B cost
    #   x * cold = x * hot + fresh_overhead * cold
    #   x * (cold - hot) = fresh_overhead * cold
    crossover_x = (
        FRESH_SESSION_OVERHEAD_TOKENS
        * PRICE_COLD_WRITE_PER_MTOK
        / (PRICE_COLD_WRITE_PER_MTOK - PRICE_HOT_READ_PER_MTOK)
    )

    fig, ax = plt.subplots(figsize=(9, 5.5), dpi=120)

    # Shaded regions: Path A wins (left of crossover), Path B wins (right of crossover)
    ax.fill_between(
        x,
        y_a,
        y_b,
        where=y_b > y_a,
        color="#e74c3c",
        alpha=0.10,
        label="_PathAWins",
    )
    ax.fill_between(
        x,
        y_b,
        y_a,
        where=y_a >= y_b,
        color="#2ecc71",
        alpha=0.10,
        label="_PathBWins",
    )

    # Path A: resume cold (the painful line)
    ax.plot(
        x,
        y_a,
        color="#e74c3c",
        linewidth=2.4,
        label="Resume session (cold write)",
    )

    # Path B: summary + fresh session (the cheap line)
    ax.plot(
        x,
        y_b,
        color="#2ecc71",
        linewidth=2.4,
        label="Summary + fresh session",
    )

    # Reference line at 500k tokens
    a_at_ref = cost_path_a(np.array([REFERENCE_X_TOKENS]))[0]
    b_at_ref = cost_path_b(np.array([REFERENCE_X_TOKENS]))[0]
    savings_at_ref = a_at_ref - b_at_ref

    ax.axvline(
        REFERENCE_X_TOKENS,
        color="#7f8c8d",
        linestyle=":",
        linewidth=1.0,
        alpha=0.7,
    )
    ax.annotate(
        (
            f"At 500k tokens:\n"
            f"  Resume cold session:     ${a_at_ref:.2f}\n"
            f"  Summary + fresh session: ${b_at_ref:.2f}\n"
            f"  Saved:                   ${savings_at_ref:.2f}"
        ),
        xy=(REFERENCE_X_TOKENS, a_at_ref),
        xytext=(180_000, max(y_a) * 0.55),
        fontsize=9,
        family="monospace",
        bbox=dict(boxstyle="round,pad=0.5", facecolor="white", edgecolor="#bdc3c7"),
        arrowprops=dict(arrowstyle="->", color="#7f8c8d", lw=1, alpha=0.7),
    )

    # Axes / formatting
    ax.set_xlabel("Original session size (input tokens)", fontsize=11)
    ax.set_ylabel("Cost per timeout event (USD)", fontsize=11)
    fig.suptitle(
        "Cost of resuming a cold session vs. summary + fresh session",
        fontsize=12,
        fontweight="bold",
        y=0.96,
    )
    subtitle = (
        f"Fresh session assumes {STARTUP_OVERHEAD_TOKENS//1000}k startup tokens "
        f"+ {SUMMARY_PASTE_TOKENS//1000}k summary paste "
        f"+ {NUM_FILE_REREADS} × {LOC_PER_FILE_REREAD}-LOC file re-reads ({FILE_REREAD_TOKENS//1000}k tokens)"
    )
    ax.set_title(
        subtitle,
        fontsize=9.5,
        style="italic",
        color="#7f8c8d",
        pad=4,
    )
    ax.set_xlim(X_MIN_TOKENS, X_MAX_TOKENS)
    ax.set_ylim(0, max(y_a) * 1.08)

    # Format x-axis as "50k", "100k", ...
    ax.set_xticks(
        [X_MIN_TOKENS] + list(np.arange(100_000, X_MAX_TOKENS + 1, 100_000))
    )
    ax.set_xticklabels([f"{int(t/1000)}k" for t in ax.get_xticks()])

    # Format y-axis as "$0.00"
    ax.yaxis.set_major_formatter(plt.FuncFormatter(lambda v, _: f"${v:.2f}"))

    ax.grid(True, linestyle="--", alpha=0.3)
    ax.legend(loc="upper left", fontsize=10, frameon=True)

    # Pricing footnote (escape $ to avoid matplotlib mathtext)
    pricing_note = (
        f"Claude Opus 4.7 pricing — "
        f"cold-write \\${PRICE_COLD_WRITE_PER_MTOK}/Mtok, "
        f"hot-read \\${PRICE_HOT_READ_PER_MTOK}/Mtok"
    )
    fig.text(
        0.5,
        0.015,
        pricing_note,
        ha="center",
        fontsize=8,
        color="#95a5a6",
    )

    plt.tight_layout(rect=(0, 0.04, 1, 0.96))

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT_PATH, format="svg", bbox_inches="tight")
    print(f"Wrote {OUT_PATH}")


if __name__ == "__main__":
    main()
