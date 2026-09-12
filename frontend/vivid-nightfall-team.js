/*
 * Vivid Nightfall — Team section, standalone vanilla JS.
 *
 * Ported from a React/TypeScript component (`team-orbit.tsx` + `lib/orbit.ts`).
 * The geometry functions are copied unchanged — they have no framework
 * dependency in the original either. The state machine (which portrait is
 * "selected", the auto-advancing dwell timer, keyboard nav, the detail
 * dialog) is reimplemented here with plain DOM APIs.
 *
 * Usage: call `renderFinanceTeam(container, members)` once, where `container`
 * is an empty element and `members` is an array of:
 *   { id, name, role, title, bio, photo, links }
 * - photo: an image URL string, or null/undefined for a monogram
 * - links: [{ platform: "LINKEDIN" | "X" | "INSTAGRAM" | "FACEBOOK" |
 *             "YOUTUBE" | "TIKTOK" | "WEBSITE" | "TEDX" | "OTHER", url }]
 */

// ---------------------------------------------------------------------------
// Geometry (lib/orbit.ts, unchanged)
// ---------------------------------------------------------------------------

const PHI = -136.6;
const FOCAL_X = 28.9;
const FOCAL_Y_RATIO = 0.351;
const CENTRE_DX = 0.7266;
const CENTRE_DY = 0.687;
const NODE_WIDTH = 14;
const FOCAL_WIDTH = 32;
const SPREAD = 8;
const RADIUS_PER_MEMBER = 3.6;
const RADIUS_MIN = 48;
const RADIUS_MAX = 90;
const COMPACT_RADIUS = 28;
const COMPACT_MAX_COUNT = 8;
const ASPECT = 1.4;
const COMPACT_ASPECT = 1.25;

function clampNum(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export function orbitLayout(count) {
  const members = Math.max(1, count);
  const compact = members <= COMPACT_MAX_COUNT;

  return {
    count: members,
    step: round(360 / members),
    radius: compact ? COMPACT_RADIUS : round(clampNum(RADIUS_PER_MEMBER * members, RADIUS_MIN, RADIUS_MAX)),
    aspect: compact ? COMPACT_ASPECT : ASPECT,
    nodeWidth: NODE_WIDTH,
    focalScale: round((compact ? FOCAL_WIDTH * 0.83 : FOCAL_WIDTH) / NODE_WIDTH),
    compact,
  };
}

export function orbitOffset(count, index, turn) {
  const members = Math.max(1, count);
  const raw = (((index - turn) % members) + members) % members;
  return raw > members / 2 ? raw - members : raw;
}

export function orbitAngle(layout, index, turn) {
  const steps = index - turn;
  const side = Math.sign(orbitOffset(layout.count, index, turn));
  return round(PHI + steps * layout.step + side * SPREAD);
}

// ---------------------------------------------------------------------------
// Social icons — brand glyphs, drawn (same paths as components/social-icons.tsx)
// ---------------------------------------------------------------------------

const SOCIAL_PATHS = {
  INSTAGRAM:
    "M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06zm0 3.678a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm7.846-10.405a1.441 1.441 0 01-2.88 0 1.44 1.44 0 012.88 0z",
  X: "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  FACEBOOK:
    "M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z",
  LINKEDIN:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  YOUTUBE:
    "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  TIKTOK:
    "M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z",
  // Generic globe (WEBSITE / TEDX) and link (OTHER).
  WEBSITE:
    "M12 2a10 10 0 100 20 10 10 0 000-20zm7.94 9h-3.06a15.6 15.6 0 00-1.3-5.6A8.03 8.03 0 0119.94 11zM12 4.06c.9 1.2 1.98 3.3 2.22 6.94H9.78c.24-3.64 1.32-5.74 2.22-6.94zM9.78 13h4.44c-.24 3.64-1.32 5.74-2.22 6.94-.9-1.2-1.98-3.3-2.22-6.94zM8.42 5.4A15.6 15.6 0 007.12 11H4.06A8.03 8.03 0 018.42 5.4zM4.06 13h3.06c.16 2.1.62 4 1.3 5.6A8.03 8.03 0 014.06 13zm11.52 5.6c.68-1.6 1.14-3.5 1.3-5.6h3.06a8.03 8.03 0 01-4.36 5.6z",
  TEDX:
    "M12 2a10 10 0 100 20 10 10 0 000-20zm7.94 9h-3.06a15.6 15.6 0 00-1.3-5.6A8.03 8.03 0 0119.94 11zM12 4.06c.9 1.2 1.98 3.3 2.22 6.94H9.78c.24-3.64 1.32-5.74 2.22-6.94zM9.78 13h4.44c-.24 3.64-1.32 5.74-2.22 6.94-.9-1.2-1.98-3.3-2.22-6.94zM8.42 5.4A15.6 15.6 0 007.12 11H4.06A8.03 8.03 0 018.42 5.4zM4.06 13h3.06c.16 2.1.62 4 1.3 5.6A8.03 8.03 0 014.06 13zm11.52 5.6c.68-1.6 1.14-3.5 1.3-5.6h3.06a8.03 8.03 0 01-4.36 5.6z",
  OTHER:
    "M3.9 12a5.1 5.1 0 015.1-5.1h3v1.8h-3a3.3 3.3 0 100 6.6h3V17h-3A5.1 5.1 0 013.9 12zM17 6.9h-3v1.8h3a3.3 3.3 0 110 6.6h-3V17h3a5.1 5.1 0 000-10.2zM8 11.1h8v1.8H8v-1.8z",
};

const SOCIAL_LABELS = {
  INSTAGRAM: "Instagram",
  X: "X",
  FACEBOOK: "Facebook",
  LINKEDIN: "LinkedIn",
  YOUTUBE: "YouTube",
  TIKTOK: "TikTok",
  WEBSITE: "website",
  TEDX: "TEDx profile",
  OTHER: "link",
};

function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  const first = Array.from(parts[0])[0] ?? "";
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? "" : "";
  return (first + last).toUpperCase();
}

function toParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function toExcerpt(text) {
  return toParagraphs(text).join(" ").replace(/\s+/g, " ");
}

function hasPersonDetail(person) {
  return (person.title ?? null) !== null || (person.bio ?? null) !== null;
}

function el(tag, className, attrs) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      node.setAttribute(key, value);
    }
  }
  return node;
}

function renderSocialLinks(links, owner) {
  if (!links || links.length === 0) return null;
  const ul = el("ul", "finance-social-links");
  for (const link of links) {
    const li = document.createElement("li");
    const a = el("a", "finance-social-link finance-press", {
      href: link.url,
      target: "_blank",
      rel: "noopener noreferrer",
    });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", SOCIAL_PATHS[link.platform] ?? SOCIAL_PATHS.OTHER);
    svg.appendChild(path);
    a.appendChild(svg);
    const sr = el("span", "sr-only");
    sr.textContent = `${owner} on ${SOCIAL_LABELS[link.platform] ?? "link"}`;
    a.appendChild(sr);
    li.appendChild(a);
    ul.appendChild(li);
  }
  return ul;
}

function renderPortrait(member, size) {
  const wrap = el("div", "finance-team-portrait");
  wrap.style.width = size;
  if (member.photo) {
    const img = document.createElement("img");
    img.src = member.photo;
    img.alt = "";
    img.loading = "lazy";
    wrap.appendChild(img);
  } else {
    const mono = el("div", "finance-team-portrait-monogram finance-display finance-display-lg", {
      "aria-hidden": "true",
    });
    mono.textContent = initials(member.name);
    wrap.appendChild(mono);
  }
  return wrap;
}

// ---------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------

export function renderFinanceTeam(container, members) {
  const layout = orbitLayout(members.length);

  container.classList.add("finance-team-frame");
  if (layout.compact) container.dataset.compact = "";
  container.style.setProperty("--finance-orbit-r", layout.radius);
  container.style.setProperty("--finance-orbit-aspect", layout.aspect);
  container.style.setProperty("--finance-node-w", layout.nodeWidth);
  container.style.setProperty("--finance-node-focal", layout.focalScale);

  // Head
  const head = el("div", "finance-team-head finance-resolve-in finance-plane-near");
  head.appendChild(el("span", "finance-team-rule", { "aria-hidden": "true" }));
  const headline = el("div", "finance-team-headline");
  const h2 = el("h2", "finance-display finance-display-lg text-finance-ink", {
    id: "finance-team-heading",
  });
  h2.textContent = "Team";
  headline.appendChild(h2);
  head.appendChild(headline);
  container.appendChild(head);

  // Stage
  const stage = el("div", "finance-team-stage");
  if (layout.compact) stage.dataset.compact = "";
  container.appendChild(stage);

  const plot = el("div", "finance-team-plot");
  stage.appendChild(plot);

  if (layout.count > 1) {
    plot.appendChild(el("span", "finance-team-ring", { "aria-hidden": "true" }));
  }

  const group = el("div", "finance-team-group", {
    role: "radiogroup",
    "aria-label": "Team members",
  });
  plot.appendChild(group);

  const corner = el("div", "finance-team-corner finance-resolve-in finance-plane-mid");
  stage.appendChild(corner);

  const readouts = el("div", "finance-team-readouts");
  corner.appendChild(readouts);

  // Dialog (shared by every member with detail to show)
  const dialog = document.createElement("dialog");
  dialog.className = "finance finance-plate finance-person-dialog";
  dialog.innerHTML = `
    <button type="button" class="finance-person-dialog-close finance-press" aria-label="Close">&times;</button>
    <div class="finance-person-dialog-body">
      <div class="finance-person-dialog-head">
        <div class="finance-person-dialog-portrait" data-portrait-slot></div>
        <div>
          <p class="finance-display finance-display-md text-finance-ink" data-name></p>
          <p class="finance-person-dialog-eyebrow" data-eyebrow hidden></p>
          <p class="finance-person-dialog-title" data-title hidden></p>
        </div>
      </div>
      <div class="finance-person-dialog-bio" data-bio hidden></div>
      <div data-links style="margin-top:1.5rem"></div>
    </div>
  `;
  document.body.appendChild(dialog);
  dialog.querySelector(".finance-person-dialog-close").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });

  function openDialog(member) {
    dialog.querySelector("[data-portrait-slot]").replaceChildren(renderPortrait(member, "100%"));
    dialog.querySelector("[data-name]").textContent = member.name;

    const eyebrow = dialog.querySelector("[data-eyebrow]");
    eyebrow.hidden = !member.role;
    eyebrow.textContent = member.role ?? "";

    const titleEl = dialog.querySelector("[data-title]");
    titleEl.hidden = !member.title;
    titleEl.textContent = member.title ?? "";

    const bioEl = dialog.querySelector("[data-bio]");
    bioEl.hidden = !member.bio;
    bioEl.replaceChildren();
    if (member.bio) {
      for (const paragraph of toParagraphs(member.bio)) {
        const p = document.createElement("p");
        p.textContent = paragraph;
        bioEl.appendChild(p);
      }
    }

    const linksSlot = dialog.querySelector("[data-links]");
    linksSlot.replaceChildren();
    const linksEl = renderSocialLinks(member.links, member.name);
    if (linksEl) linksSlot.appendChild(linksEl);

    dialog.showModal();
  }

  // Build one node + one readout per member.
  const buttons = [];
  members.forEach((member, index) => {
    const node = el("div", "finance-team-node");
    node.style.setProperty("--finance-i", Math.min(index, 6));

    const button = el("button", "finance-team-lens-button", {
      type: "button",
      role: "radio",
      "aria-checked": "false",
      tabindex: "-1",
    });
    buttons.push(button);

    const lens = el("span", "finance-team-lens");
    lens.appendChild(renderPortrait(member, "100%"));
    button.appendChild(lens);

    const caption = el("span", "finance-team-caption");
    caption.textContent = member.name;
    button.appendChild(caption);

    button.addEventListener("click", () => bring(index));
    button.addEventListener("keydown", (event) => onKeyDown(event, index));

    node.appendChild(button);
    group.appendChild(node);

    const readout = el("div", "finance-team-readout");
    const body = el("div", "finance-team-readout-body");

    if (member.links && member.links.length > 0) {
      const meta = el("div", "finance-team-meta");
      meta.appendChild(renderSocialLinks(member.links, member.name));
      body.appendChild(meta);
    }

    const identity = document.createDocumentFragment();
    if (member.role) {
      const role = el("p", "finance-team-role text-finance-accent");
      role.textContent = member.role;
      identity.appendChild(role);
    }
    const name = el("p", "finance-display finance-team-name text-finance-ink");
    name.textContent = member.name;
    identity.appendChild(name);
    if (member.title) {
      const suffix = el("span", "finance-team-suffix text-finance-muted");
      suffix.textContent = member.title;
      identity.appendChild(suffix);
    }

    if (hasPersonDetail(member)) {
      const trigger = el("button", "finance-team-trigger", { type: "button" });
      trigger.appendChild(identity);
      const sr = el("span", "sr-only");
      sr.textContent = ` — read more about ${member.name}`;
      trigger.appendChild(sr);
      trigger.appendChild(el("span", "finance-team-underline", { "aria-hidden": "true" }));
      trigger.addEventListener("click", () => openDialog(member));
      body.appendChild(trigger);
    } else {
      const plain = el("div", "finance-team-trigger");
      plain.appendChild(identity);
      body.appendChild(plain);
    }

    if (member.bio) {
      const bio = el("p", "finance-team-bio text-finance-muted");
      bio.textContent = toExcerpt(member.bio);
      body.appendChild(bio);
    }

    readout.appendChild(body);
    readouts.appendChild(readout);
  });

  // Transport (arrows + position counter)
  let stepsWrap = null;
  if (layout.count > 1) {
    stepsWrap = el("div", "finance-team-steps", { "aria-hidden": "true" });
    const prev = el("button", "finance-team-step", { type: "button", tabindex: "-1" });
    prev.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5m0 0 6-6m-6 6 6 6"/></svg>';
    const next = el("button", "finance-team-step", { type: "button", tabindex: "-1" });
    next.innerHTML =
      '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m0 0-6-6m6 6-6 6"/></svg>';
    prev.addEventListener("click", () => rotate(-1));
    next.addEventListener("click", () => rotate(1));

    const position = el("p", "finance-label finance-figures finance-team-position");
    const current = el("span", "text-finance-accent");
    const rule = el("span", "finance-team-position-rule");
    const total = document.createElement("span");
    total.textContent = String(layout.count).padStart(2, "0");
    position.append(current, rule, total);

    stepsWrap.append(prev, next, position);
    corner.appendChild(stepsWrap);
  }

  // -------------------------------------------------------------------------
  // State: which portrait is on the focal plane, and the auto-advance timer.
  // -------------------------------------------------------------------------
  let turn = 0;
  const count = layout.count;

  function selectedIndex() {
    return ((turn % count) + count) % count;
  }

  function render() {
    const selected = selectedIndex();
    const nodes = group.children;

    for (let index = 0; index < count; index++) {
      const offset = orbitOffset(count, index, turn);
      const angle = orbitAngle(layout, index, turn);
      const node = nodes[index];
      const isSelected = offset === 0;

      node.style.transform = `rotate(${angle}deg) translate(calc(var(--finance-orbit-r) * 1cqw)) rotate(${-angle}deg)`;
      node.style.setProperty("--finance-d", Math.max(0.34, 1 - Math.abs(offset) * 0.22));
      node.style.setProperty("--finance-off", Math.abs(offset));
      node.style.setProperty("--finance-z", Math.max(1, 20 - Math.abs(offset)));

      if (isSelected) node.dataset.selected = "";
      else delete node.dataset.selected;

      buttons[index].setAttribute("aria-checked", String(isSelected));
      buttons[index].tabIndex = isSelected ? 0 : -1;
    }

    Array.from(readouts.children).forEach((readout, index) => {
      if (index === selected) {
        readout.dataset.selected = "";
        readout.inert = false;
      } else {
        delete readout.dataset.selected;
        readout.inert = true;
      }
    });

    if (stepsWrap) {
      stepsWrap.querySelector(".finance-team-position .text-finance-accent").textContent = String(
        selected + 1,
      ).padStart(2, "0");
    }
  }

  function rotate(by) {
    turn += by;
    render();
  }

  function bring(index) {
    turn += orbitOffset(count, index, turn);
    render();
  }

  function focusOn(index) {
    bring(index);
    buttons[index].focus();
  }

  function onKeyDown(event, index) {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        focusOn((index + 1) % count);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        focusOn((index - 1 + count) % count);
        break;
      case "Home":
        focusOn(0);
        break;
      case "End":
        focusOn(count - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  render();

  // Dwell clock: the aperture ring's own animationend turns the ring.
  stage.addEventListener("animationend", (event) => {
    if (event.animationName === "finance-team-dwell") rotate(1);
  });

  requestAnimationFrame(() => {
    if (count > 1) stage.dataset.rotating = "";
  });

  const observer = new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting) stage.dataset.onscreen = "";
      else delete stage.dataset.onscreen;
    },
    { threshold: 0.25 },
  );
  observer.observe(stage);

  return { rotate, bring };
}
