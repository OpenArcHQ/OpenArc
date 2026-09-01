# OpenArc brand system

Status: **directional identity system**  
Prepared: **2026-08-15**  
Logo reference: [`../assets/openarc-logo.jpeg`](../assets/openarc-logo.jpeg)

## Brand idea

OpenArc makes autonomous economic activity legible.

The identity should feel like a calm observability instrument: open, precise,
technical, and trustworthy. It should not resemble a speculative token brand, an
AI chatbot, or an enterprise compliance dashboard assembled from generic cards.

The supplied mark suggests three useful ideas:

- **Arc:** a complete path from intent to settlement.
- **Aperture:** a lens that makes opaque activity visible.
- **Open system:** multiple evidence streams meeting without collapsing into one
  unverifiable claim.

These interpretations are brand language, not claims about the mark's original
design intent.

## Logo handling

Use the circular mark as the primary icon. Give it generous white or dark-blue
space and let its internal negative space remain the focus.

Do:

- Preserve the circular silhouette and internal white channels.
- Use the grainy raster version for editorial art and atmospheric launch work.
- Produce a clean vector master for navigation, favicons, documentation, and
  small UI surfaces.
- Create light-background, dark-background, single-color, and 16/24/32-pixel
  optical variants from the approved vector master.
- Pair the icon with the wordmark **OpenArc**, preserving the capital O and A.

Do not:

- Auto-trace the supplied JPEG and treat the result as the final master.
- Recolor individual lobes into a rainbow.
- Add a robot face, blockchain cube, dollar sign, or sparkle to the mark.
- Rotate, stretch, outline, emboss, or place text inside the circle.
- imply that the mark is an Arc or Circle network logo.

Before public launch, complete a trademark search for **OpenArc**, obtain the
editable source, and document ownership and permitted usage.

## Color system

The values below are working UI tokens sampled conceptually from the supplied
logo. They must be contrast-tested in the eventual interface; they are not a
pixel-perfect extraction or print specification.

| Token | Hex | Primary use |
|---|---:|---|
| Arc Ink | `#08172F` | Dark backgrounds and primary text on light |
| Deep Arc | `#0B4DB8` | Brand field, major controls, active states |
| Signal Blue | `#197FCF` | Links, selected evidence, diagrams |
| Open Sky | `#69BCE3` | Secondary paths, hover states, charts |
| Horizon Gold | `#EFB94F` | Human approval, exceptions, focused CTA |
| Soft Gold | `#F7D98B` | Quiet highlighting and chart bands |
| Paper | `#F6F5F0` | Primary light surface |
| Cloud | `#E9EEF2` | Dividers and secondary panels |
| Slate | `#536277` | Secondary text on light surfaces |
| White | `#FFFFFF` | High-contrast text and negative space |

Color semantics:

- **Blue** means observed, connected, or informational.
- **Gold** means human attention, approval, or a decision boundary. It does not
  mean profit, yield, or guaranteed success.
- **Green** may indicate a reconciled state only after every required evidence
  layer agrees.
- **Red** is reserved for failed, conflicting, expired, or policy-breaking states.
- Never encode an evidence state by color alone.

## Typography

Candidate open-font stack:

- Display: **Space Grotesk**, medium or semibold.
- Interface and body: **Inter**, regular and medium.
- Identifiers and evidence: **IBM Plex Mono**, regular and medium.

Fallback stack:

```css
--font-display: "Space Grotesk", "Inter", system-ui, sans-serif;
--font-body: "Inter", system-ui, sans-serif;
--font-data: "IBM Plex Mono", ui-monospace, monospace;
```

Typography rules:

- Use sentence case for product explanations.
- Use restrained uppercase for state labels such as `SETTLED` or `INCOMPLETE`.
- Never render wallet addresses or transaction hashes in a decorative font.
- Prefer direct language over dense acronyms; explain x402, AP2, and Gateway on
  first use.

## Graphic language

The core visual is an **evidence arc**, not a price chart:

```text
Intent → Permission → Attempt → Authorization → Fulfillment → Settlement
```

Recommended graphics:

- Curved paths joining evidence nodes.
- Concentric rings showing policy boundaries and spending limits.
- Split-screen comparisons between declared intent and observed settlement.
- Quiet topology maps of agents, services, wallets, and networks.
- Receipt timelines with source class, timestamp, and confidence.
- Layered translucent blue fields with a single gold human-decision node.
- Grain used sparingly in campaign art, never over small text or data.

Avoid:

- Candlestick charts as the default product visual.
- Robot heads, glowing brains, generic chat bubbles, or humanoid agents.
- Green arrows, rockets, cash stacks, luxury imagery, and token-price hype.
- Dense node webs without a readable story.
- Fabricated transaction volume or simulated customer metrics presented as real.

## Illustration direction

Editorial illustrations should show systems and relationships rather than
characters. A useful composition contains:

1. One human approval or policy boundary in gold.
2. One or more agent/service paths in blue.
3. Evidence checkpoints represented by open circles.
4. A final settlement node with a clearly separate verification state.

Every fictional example must be marked `SAMPLE`, `TESTNET`, or `ILLUSTRATIVE`.

## Motion

Motion should explain causality:

- On load, trace one arc from permission to settlement in 700–1,000 ms.
- On workspace change, crossfade panels while preserving the evidence timeline.
- On new evidence, pulse only the affected node.
- On conflict, separate the two disagreeing paths rather than shaking the screen.
- On settlement, close the path only when the underlying status is confirmed.

Honor `prefers-reduced-motion`. Reduced motion should render the complete state
immediately with no continuous background animation.

## Product UI principles

1. **Evidence before interpretation.** Show the source and timestamp beside the
   conclusion.
2. **State before celebration.** A signed payment is not necessarily settled; a
   settled payment is not necessarily fulfilled.
3. **Human authority remains visible.** The applicable policy or mandate should
   never disappear behind an agent summary.
4. **Unknown is a designed state.** Missing intent, missing fulfillment, and
   unsupported agents get explicit treatments.
5. **No false omniscience.** The interface never suggests that OpenArc can see
   private reasoning it was not given.

## Voice

OpenArc sounds calm, forensic, and useful.

Use:

- Observed, authorized, attempted, fulfilled, settled, reconciled.
- Supplied evidence, signed evidence, onchain fact, provider receipt.
- We could not verify, no matching record was supplied, outside policy.
- What happened, why it matters, what remains unknown.

Avoid:

- Omniscient, fully autonomous, guaranteed, trustless by default, foolproof.
- We know why the agent did this.
- Safe transaction or verified agent without naming the exact check.
- Compliance-ready unless a named control and formal review support the claim.

## Working lockups

Primary:

```text
[MARK] OpenArc
       Agent activity, made legible.
```

Developer:

```text
[MARK] OpenArc
       Evidence infrastructure for the agentic economy.
```

Consumer/operator:

```text
[MARK] OpenArc
       See what was allowed. See what happened.
```

