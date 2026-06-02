import { parseBackupFile } from "./parser.js";
const dagre = globalThis.dagre;

const fileInput = document.querySelector("#backup-file");
const fileName = document.querySelector("#file-name");
const statusEl = document.querySelector("#status");
const searchInput = document.querySelector("#search");
const emptyState = document.querySelector("#empty-state");
const diagramPanel = document.querySelector("#diagram-panel");
const diagramWrap = document.querySelector("#diagram-wrap");
const svg = document.querySelector("#diagram");
const details = document.querySelector("#details");
const pageTitle = document.querySelector("#page-title");
const pageSubtitle = document.querySelector("#page-subtitle");
const welcomeCard = document.querySelector("#welcome-card");

let currentSystem = null;
let currentPage = "all-trunks";
let lastRenderedGraph = null;
let lastQuery = "";
let hoursMode = "all";
const expansionState = new Set();
let focusedDidNodeId = null;

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;

  fileName.textContent = file.name;
  setStatus("Reading backup...");

  try {
    currentSystem = await parseBackupFile(file);
    setAppReady(true);
    updateStats(currentSystem);
    emptyState.classList.add("is-hidden");
    diagramPanel.classList.remove("is-hidden");
    welcomeCard.classList.add("is-hidden");
    setStatus(`Loaded ${file.name} from ${currentSystem.sourceEntry}.`);
    buildTrunkTabs(currentSystem);
    render();
  } catch (error) {
    console.error(error);
    currentSystem = null;
    setAppReady(false);
    updateStats(null);
    emptyState.classList.remove("is-hidden");
    diagramPanel.classList.add("is-hidden");
    welcomeCard.classList.remove("is-hidden");
    setStatus(error.message || "Could not read this backup.");
  }
});

searchInput.addEventListener("input", () => render());

const tabsEl = document.querySelector("#tabs");
const hoursTabsEl = document.querySelector("#hours-tabs");

tabsEl.addEventListener("click", (event) => {
  const button = event.target.closest(".tab");
  if (!button) return;
  currentPage = button.dataset.page;
  setActiveTab(button);
  updatePageHeader();
  render();
});

hoursTabsEl.addEventListener("click", (event) => {
  const button = event.target.closest(".subtab");
  if (!button) return;
  hoursMode = button.dataset.hours || "all";
  setActiveHoursTab(button);
  updatePageHeader();
  render();
});

document.querySelector("#fit-view").addEventListener("click", () => {
  diagramWrap.scrollTo({ top: 0, left: 0, behavior: "smooth" });
});
document.querySelector("#expand-all").addEventListener("click", () => {
  if (!currentSystem) return;
  expandAllExpansibleNodes(currentSystem, expansionState);
  render();
});
document.querySelector("#collapse-all").addEventListener("click", () => {
  expansionState.clear();
  render();
});

document.querySelector("#export-html").addEventListener("click", () => {
  if (!currentSystem || !lastRenderedGraph) return;

  const html = buildTreeExportHtml(currentSystem, lastRenderedGraph, currentPage, lastQuery);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${currentPage}-call-routing-tree.html`;
  a.click();
  URL.revokeObjectURL(url);
});

document.querySelector("#export-pdf").addEventListener("click", () => {
  if (!currentSystem || !lastRenderedGraph) return;
  exportDiagramPdf();
});

function setAppReady(isReady) {
  document.body.classList.toggle("app-ready", isReady);
}

function render() {
  if (!currentSystem) return;

  const query = searchInput.value.trim().toLowerCase();
  const graph = buildGraph(currentSystem, currentPage, hoursMode);
  const filtered = filterGraph(graph, query);
  lastRenderedGraph = filtered;
  lastQuery = query;
  renderSvg(filtered);
  renderDetails(currentSystem, currentPage, filtered, query);
  setStatus(statusForGraph(currentSystem, filtered, query));
}

function buildGraph(system, page, selectedHoursMode = "all") {
  const trunkNumber = page === "all-trunks" ? null : page.replace("trunk:", "");
  return buildTrunkGraph(system, trunkNumber, selectedHoursMode);
}

function shouldShowTrunkRule(rule) {
  const match = String(rule?.match || "").trim();
  const name = String(rule?.name || "").trim();
  return Boolean(match || name);
}

function buildTrunkGraph(system, selectedTrunkNumber = null, selectedHoursMode = "all") {
  const graph = createGraph(system);

  system.trunks
    .filter((trunk, trunkIndex) => !selectedTrunkNumber || String(trunk.number || trunkIndex + 1) === selectedTrunkNumber)
    .forEach((trunk, trunkIndex) => {
    const trunkId = addNode(graph, {
      key: `trunk:${trunk.number || trunkIndex}`,
      kind: "Trunk",
      title: trunk.name || `Trunk ${trunk.number || trunkIndex + 1}`,
      sub: [trunk.number && `Trunk ${trunk.number}`, trunk.direction].filter(Boolean).join(" | "),
      depth: 0,
      search: [trunk.name, trunk.number, trunk.direction].join(" "),
    });

    const trunkKey = trunk.number || trunkIndex;
    const visibleRules = trunk.rules.filter(shouldShowTrunkRule);
    const rules = visibleRules.length
      ? visibleRules
      : [{
      name: "Default inbound route",
      match: trunk.dids.join(", "),
      office: null,
      outOfHours: null,
      holidays: null,
    }];

    rules.forEach((rule, ruleIndex) => {
      const ruleId = addNode(graph, {
        key: `did:${trunkKey}:${ruleIndex}`,
        kind: "DID",
        title: rule.match || rule.name || "Inbound rule",
        sub: rule.name || rule.condition || "DID rule",
        depth: 1,
        search: [rule.name, rule.match, rule.condition].join(" "),
      });
      addEdge(graph, trunkId, ruleId, "DID");
      const didExpansionKey = `DID:${trunkKey}:${ruleIndex}`;
      if (isExpanded(didExpansionKey)) {
        if (selectedHoursMode === "all" || selectedHoursMode === "office") {
          expandDestination(graph, rule.office, ruleId, 2, "Office hours", selectedHoursMode);
        }
        if (selectedHoursMode === "all" || selectedHoursMode === "after") {
          expandDestination(graph, rule.outOfHours, ruleId, 2, "After-hours", selectedHoursMode);
        }
        if (selectedHoursMode === "all" || selectedHoursMode === "holiday") {
          expandDestination(graph, rule.holidays, ruleId, 2, "Holiday", selectedHoursMode);
        }
      }
    });
  });

  return graph;
}

function createGraph(system) {
  return {
    system,
    nodes: new Map(),
    edges: [],
    expanded: new Set(),
  };
}

function addNode(graph, node) {
  const existing = graph.nodes.get(node.key);
  if (existing) {
    existing.depth = Math.min(existing.depth, node.depth);
    existing.search = `${existing.search} ${node.search || ""}`;
    return existing.id;
  }

  const id = `n${graph.nodes.size}`;
  graph.nodes.set(node.key, {
    id,
    key: node.key,
    kind: node.kind,
    title: node.title || node.kind,
    sub: node.sub || "",
    depth: node.depth || 0,
    search: `${node.kind} ${node.title || ""} ${node.sub || ""} ${node.search || ""}`.toLowerCase(),
  });
  return id;
}

function addEdge(graph, from, to, label) {
  if (!from || !to) return;
  const key = `${from}->${to}:${label || ""}`;
  if (graph.edges.some((edge) => edge.key === key)) return;
  graph.edges.push({ key, from, to, label: label || "" });
}

function expandDestination(graph, destination, fromId, depth, label, selectedHoursMode = "all") {
  const nodeId = destinationNode(graph, destination, depth);
  if (!nodeId) return;
  addEdge(graph, fromId, nodeId, label);

  const dest = normalizeDestination(destination);
  if (!dest || !dest.dn) return;

  const expansionKey = `${dest.kind}:${dest.dn || dest.external || dest.raw || ""}`;
  if (graph.expanded.has(expansionKey)) return;
  graph.expanded.add(expansionKey);

  const system = graph.system;

  if (dest.kind === "IVR" && system.ivrs[dest.dn] && isExpanded(expansionKey)) {
    const ivr = system.ivrs[dest.dn];
    ivr.options.forEach((option) => {
      expandDestination(graph, option.destination, nodeId, depth + 1, option.digit ? `Press ${option.digit}` : "Menu", selectedHoursMode);
    });
    expandDestination(graph, ivr.timeoutDestination, nodeId, depth + 1, ivr.timeout ? `Timeout ${ivr.timeout}s` : "Timeout", selectedHoursMode);
    if (shouldShowScheduledRoute(selectedHoursMode, "office")) {
      expandDestination(graph, ivr.officeRoute, nodeId, depth + 1, "Office route", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "after")) {
      expandDestination(graph, ivr.outOfHoursRoute, nodeId, depth + 1, "After-hours", selectedHoursMode);
    }
    if (selectedHoursMode === "all") {
      expandDestination(graph, ivr.breakRoute, nodeId, depth + 1, "Break route", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "holiday")) {
      expandDestination(graph, ivr.holidaysRoute, nodeId, depth + 1, "Holiday route", selectedHoursMode);
    }
  } else if (dest.kind === "RingGroup" && system.ringGroups[dest.dn] && isExpanded(expansionKey)) {
    const rg = system.ringGroups[dest.dn];
    if (shouldShowScheduledRoute(selectedHoursMode, "office")) {
      expandDestination(graph, rg.officeHoursDestination, nodeId, depth + 1, "Office hours", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "after")) {
      expandDestination(graph, rg.outOfOfficeHoursDestination, nodeId, depth + 1, "After-hours", selectedHoursMode);
    }
    if (shouldShowScheduledRoute(selectedHoursMode, "holiday")) {
      expandDestination(graph, rg.holidaysDestination, nodeId, depth + 1, "Holiday", selectedHoursMode);
    }
    expandDestination(graph, rg.noAnswer, nodeId, depth + 1, "No answer", selectedHoursMode);
    addMemberSummaryNode(graph, nodeId, depth + 1, "Member", rg.members || [], `ring-members:${dest.dn}`);
  } else if (dest.kind === "Queue" && system.queues[dest.dn]) {
    const queue = system.queues[dest.dn];
    const queueTimeout = queue.masterTimeout || queue.ringTimeout || "";
    if (isExpanded(expansionKey)) {
      if (shouldShowScheduledRoute(selectedHoursMode, "office")) {
        expandDestination(graph, queue.officeHoursDestination, nodeId, depth + 1, "Office hours", selectedHoursMode);
      }
      if (shouldShowScheduledRoute(selectedHoursMode, "after")) {
        expandDestination(graph, queue.outOfOfficeHoursDestination, nodeId, depth + 1, "After-hours", selectedHoursMode);
      }
      if (shouldShowScheduledRoute(selectedHoursMode, "holiday")) {
        expandDestination(graph, queue.holidaysDestination, nodeId, depth + 1, "Holiday", selectedHoursMode);
      }
      expandDestination(graph, queue.timeoutDestination, nodeId, depth + 1, queueTimeout ? `Timeout ${queueTimeout}s` : "Timeout", selectedHoursMode);
      addMemberSummaryNode(graph, nodeId, depth + 1, "Agent", queue.members || [], `queue-members:${dest.dn}`);
    }
  } else if (dest.kind === "IVR" && system.ivrs[dest.dn] && !isExpanded(expansionKey)) {
    const ivr = system.ivrs[dest.dn];
    expandDestination(graph, ivr.timeoutDestination, nodeId, depth + 1, ivr.timeout ? `Timeout ${ivr.timeout}s` : "Timeout", selectedHoursMode);
  }
}

function shouldShowScheduledRoute(selectedHoursMode, routeHoursMode) {
  return selectedHoursMode === "all" || selectedHoursMode === routeHoursMode;
}

function addMemberSummaryNode(graph, parentId, depth, labelPrefix, members, key) {
  if (!members.length) return;
  const summaryId = addNode(graph, {
    key,
    kind: "Summary",
    title: `${members.length} ${labelPrefix.toLowerCase()}${members.length === 1 ? "" : "s"}`,
    sub: "Expand to inspect full routes",
    depth,
    search: members.join(" "),
  });
  addEdge(graph, parentId, summaryId, labelPrefix);
}

function isExpanded(key) {
  return expansionState.has(key);
}

function destinationNode(graph, destination, depth) {
  const dest = normalizeDestination(destination);
  if (!dest) return null;

  const key = destinationKey(dest);
  const label = destinationLabel(graph.system, dest);
  return addNode(graph, {
    key,
    kind: label.kind,
    title: label.title,
    sub: label.sub,
    depth,
    search: [dest.kind, dest.dn, dest.external, label.title, label.sub].join(" "),
  });
}

function normalizeDestination(destination) {
  if (!destination) return null;
  if (destination.kind === "None") return { kind: "None", dn: "", external: "" };
  if (destination.kind === "External") return destination.external ? destination : null;
  if (["Extension", "IVR", "RingGroup", "Queue", "VoiceMail", "RoutePoint"].includes(destination.kind) && !destination.dn) {
    return { kind: "End", dn: "", external: "", raw: `${destination.kind} unset` };
  }
  return destination;
}

function destinationKey(dest) {
  if (dest.kind === "External") return `external:${dest.external}`;
  if (dest.kind === "None") return "end:none";
  if (dest.kind === "End") return `end:${dest.raw || "unset"}`;
  return `${dest.kind.toLowerCase()}:${dest.dn}`;
}

function destinationLabel(system, dest) {
  if (dest.kind === "External") {
    return { kind: "External", title: "External", sub: dest.external };
  }
  if (dest.kind === "VoiceMail") {
    return { kind: "VoiceMail", title: `Voicemail ${dest.dn}`, sub: displayExtension(system.extensions[dest.dn]) };
  }
  if (dest.kind === "Extension") {
    return { kind: "Extension", title: `Ext ${dest.dn}`, sub: displayExtension(system.extensions[dest.dn]) };
  }
  if (dest.kind === "IVR") {
    const ivr = system.ivrs[dest.dn];
    const extensionList = getIvrExtensions(system, ivr);
    const detail = [ivr?.name || "Digital receptionist", extensionList && `Ext: ${extensionList}`].filter(Boolean).join(" | ");
    return { kind: "IVR", title: `IVR ${dest.dn}`, sub: detail };
  }
  if (dest.kind === "RingGroup") {
    const rg = system.ringGroups[dest.dn];
    const memberList = formatExtensionList(rg?.members || []);
    const detail = [rg?.name || "", memberList && `Ext: ${memberList}`].filter(Boolean).join(" | ");
    return { kind: "RingGroup", title: `Ring Group ${dest.dn}`, sub: detail };
  }
  if (dest.kind === "Queue") {
    const queue = system.queues[dest.dn];
    const memberList = formatExtensionList(queue?.members || []);
    const detail = [queue?.name || "", memberList && `Ext: ${memberList}`].filter(Boolean).join(" | ");
    return { kind: "Queue", title: `Queue ${dest.dn}`, sub: detail };
  }
  if (dest.kind === "RoutePoint") {
    return { kind: "RoutePoint", title: `Route Point ${dest.dn}`, sub: system.routePoints[dest.dn] || "" };
  }
  return { kind: "End", title: dest.raw || dest.kind || "End", sub: "" };
}

function filterGraph(graph, query) {
  const allNodes = Array.from(graph.nodes.values());
  if (!query) {
    return { nodes: allNodes, edges: graph.edges };
  }

  const outgoing = new Map();
  const incoming = new Map();
  graph.edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  });

  const keep = new Set();

  const matchingNodes = allNodes.filter((node) => node.search.includes(query));
  const didExactMatches = matchingNodes.filter((node) => node.kind === "DID" && matchesDidQuery(node, query));
  const seedNodes = didExactMatches.length ? didExactMatches : matchingNodes;

  seedNodes.forEach((node) => {
    keep.add(node.id);
    collectAncestors(node.id, incoming, keep);
    collectDescendants(node.id, outgoing, keep);
  });
  seedNodes.forEach((node) => {
    const [kind, ...rest] = node.key.split(":");
    const value = rest.join(":");
    if (kind === "ivr" && value) expansionState.add(`IVR:${value}`);
    if (kind === "ringgroup" && value) expansionState.add(`RingGroup:${value}`);
    if (kind === "queue" && value) expansionState.add(`Queue:${value}`);
    if (kind === "did" && value) expansionState.add(`DID:${value}`);
  });

  return {
    nodes: allNodes.filter((node) => keep.has(node.id)),
    edges: graph.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}

function collectAncestors(id, incoming, keep) {
  const parents = incoming.get(id) || [];
  parents.forEach((parentId) => {
    if (keep.has(parentId)) return;
    keep.add(parentId);
    collectAncestors(parentId, incoming, keep);
  });
}

function collectDescendants(id, outgoing, keep) {
  const children = outgoing.get(id) || [];
  children.forEach((childId) => {
    if (keep.has(childId)) return;
    keep.add(childId);
    collectDescendants(childId, outgoing, keep);
  });
}

function matchesDidQuery(node, query) {
  const text = `${node.title} ${node.sub}`.toLowerCase();
  const compactText = text.replace(/[^a-z0-9*]/g, "");
  const compactQuery = query.toLowerCase().replace(/[^a-z0-9*]/g, "");
  if (!compactQuery) return false;
  return compactText.includes(compactQuery);
}


function classifyEdge(label = "") {
  const text = String(label || "").toLowerCase();
  if (text.includes("office")) return "office";
  if (text.includes("after")) return "after";
  if (text.includes("holiday")) return "holiday";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("no answer")) return "no-answer";
  return "default";
}

function edgeClass(label = "") {
  return `edge edge-${classifyEdge(label)}`;
}

function cycleDiagnostics(graph) {
  const adjacency = new Map(graph.nodes.map((node) => [node.id, []]));
  graph.edges.forEach((edge) => {
    if (adjacency.has(edge.from) && adjacency.has(edge.to)) adjacency.get(edge.from).push(edge.to);
  });

  let index = 0;
  const stack = [];
  const onStack = new Set();
  const ids = new Map();
  const low = new Map();
  const sccs = [];

  function strongConnect(v) {
    ids.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);

    for (const w of adjacency.get(v) || []) {
      if (!ids.has(w)) {
        strongConnect(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), ids.get(w)));
      }
    }

    if (low.get(v) === ids.get(v)) {
      const component = [];
      while (stack.length) {
        const w = stack.pop();
        onStack.delete(w);
        component.push(w);
        if (w === v) break;
      }
      sccs.push(component);
    }
  }

  graph.nodes.forEach((node) => {
    if (!ids.has(node.id)) strongConnect(node.id);
  });

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const cycles = [];
  sccs.forEach((component) => {
    if (component.length > 1) {
      const labels = component.map((id) => byId.get(id)?.title || id).sort((a, b) => a.localeCompare(b));
      cycles.push(labels);
      return;
    }
    const only = component[0];
    if ((adjacency.get(only) || []).includes(only)) {
      const label = byId.get(only)?.title || only;
      cycles.push([label]);
    }
  });

  return cycles.sort((a, b) => a.join(" -> ").localeCompare(b.join(" -> ")));
}


function buildAdjacency(edges) {
  const outgoing = new Map();
  const incoming = new Map();
  edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  });
  return { outgoing, incoming };
}

function collectConnectedPath(seedId, graph) {
  if (!seedId) return new Set();
  const { outgoing, incoming } = buildAdjacency(graph.edges);
  const keep = new Set([seedId]);
  collectAncestors(seedId, incoming, keep);
  collectDescendants(seedId, outgoing, keep);
  return keep;
}

function nodeSizing(node) {
  const titleLines = wrap(node.title || "", 25).slice(0, 3);
  const subtitleLines = wrap(node.sub || "", 29).slice(0, 3);
  const titleCount = Math.max(1, titleLines.length);
  const subCount = subtitleLines.filter(Boolean).length;
  const titleH = titleCount * 15;
  const subH = subCount ? subCount * 15 : 0;
  const height = Math.max(84, 18 + titleH + (subH ? 9 + subH : 0) + 14);
  return { width: 240, height, titleLines, subtitleLines };
}

function renderSvg(graph) {
  svg.replaceChildren();

  if (!graph.nodes.length) {
    svg.setAttribute("viewBox", "0 0 900 260");
    svg.innerHTML = `<text x="40" y="70" fill="#66717d" font-size="18">No routes match the current filter.</text>`;
    return;
  }

  if (!dagre?.graphlib?.Graph) {
    svg.setAttribute("viewBox", "0 0 900 260");
    svg.innerHTML = `<text x="40" y="70" fill="#a0422a" font-size="16">Layout engine unavailable. Reload and try again.</text>`;
    return;
  }

  const margin = 40;
  const focusedPath = collectConnectedPath(focusedDidNodeId, graph);
  const hasFocus = focusedPath.size > 0;
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const layout = new dagre.graphlib.Graph({ multigraph: true }).setGraph({ rankdir: "TB", nodesep: 55, ranksep: 110, marginx: margin, marginy: margin }).setDefaultEdgeLabel(() => ({}));
  graph.nodes.forEach((node) => {
    node.size = nodeSizing(node);
    layout.setNode(node.id, { width: node.size.width, height: node.size.height });
  });
  graph.edges.forEach((edge, idx) => layout.setEdge(edge.from, edge.to, { label: edge.label, id: idx }));
  dagre.layout(layout);
  graph.nodes.forEach((node) => {
    const p = layout.node(node.id);
    node.x = p.x - node.size.width / 2;
    node.y = p.y - node.size.height / 2;
  });
  const width = Math.max(900, layout.graph().width + margin * 2);
  const height = Math.max(420, layout.graph().height + margin * 2);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", height);

  const laneLayer = el("g", { class: "lanes" });
  const edgeLayer = el("g", { class: "edges" });
  const nodeLayer = el("g", { class: "nodes" });
  svg.append(laneLayer, edgeLayer, nodeLayer);

  const depths = [...new Set(graph.nodes.map((node) => node.depth))].sort((a, b) => a - b);
  const laneNames = { 0: "Trunks", 1: "DIDs", 2: "Destinations" };
  depths.forEach((depth) => {
    const laneNodes = graph.nodes.filter((node) => node.depth === depth);
    if (!laneNodes.length) return;
    const top = Math.min(...laneNodes.map((n) => n.y)) - 22;
    const bottom = Math.max(...laneNodes.map((n) => n.y + n.size.height)) + 16;
    laneLayer.append(el("rect", { class: "depth-lane", x: 0, y: top, width, height: bottom - top }));
    laneLayer.append(el("text", { class: "depth-lane-label", x: 14, y: top + 16 }, laneNames[depth] || `Depth ${depth}`));
  });

  graph.edges.forEach((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return;

    const x1 = from.x + from.size.width / 2;
    const y1 = from.y + from.size.height;
    const x2 = to.x + to.size.width / 2;
    const y2 = to.y;
    const midY = y1 + Math.max(36, (y2 - y1) / 2);
    const muted = hasFocus && (!focusedPath.has(edge.from) || !focusedPath.has(edge.to));
    edgeLayer.append(el("path", {
      class: `${edgeClass(edge.label)}${muted ? " is-muted" : ""}`,
      d: `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`,
    }));

    if (edge.label) {
      const lx = (x1 + x2) / 2;
      const ly = midY - 6;
      const labelClass = `edge-chip edge-chip-${classifyEdge(edge.label)}${muted ? " is-muted" : ""}`;
      const labelWidth = Math.max(42, edge.label.length * 6.8 + 14);
      edgeLayer.append(el("g", { class: labelClass },
        el("rect", { x: lx - labelWidth / 2, y: ly - 12, rx: 9, width: labelWidth, height: 18 }),
        el("text", { class: "edge-label", x: lx, y: ly, "text-anchor": "middle" }, edge.label),
      ));
    }
  });

  graph.nodes.forEach((node) => {
    const isFocusNode = node.kind === "DID" && focusedDidNodeId === node.id;
    const muted = hasFocus && !focusedPath.has(node.id);
    const group = el("g", {
      class: `node kind-${node.kind.toLowerCase()}${muted ? " is-muted" : ""}${isFocusNode ? " is-focused" : ""}`,
      transform: `translate(${node.x} ${node.y})`,
    });
    group.append(el("rect", { class: "node-card", width: node.size.width, height: node.size.height, rx: 8 }));
    appendWrappedText(group, node.size.titleLines, 14, 24, "node-title");
    appendWrappedText(group, node.size.subtitleLines, 14 + 0, 24 + (node.size.titleLines.length * 15) + 8, "node-sub");
    if (node.kind === "DID") {
      group.addEventListener("click", () => {
        focusedDidNodeId = focusedDidNodeId === node.id ? null : node.id;
        render();
      });
    }
    if (isExpandableNode(node)) {
      const expanded = isExpanded(node.key.replace(/^did/, "DID").replace(/^ivr/, "IVR").replace(/^ringgroup/, "RingGroup").replace(/^queue/, "Queue"));
      const affordance = el("circle", { class: "expand-dot", cx: node.size.width - 14, cy: 14, r: 9 });
      affordance.addEventListener("click", (event) => {
        event.stopPropagation();
        const stateKey = node.key.replace(/^did/, "DID").replace(/^ivr/, "IVR").replace(/^ringgroup/, "RingGroup").replace(/^queue/, "Queue");
        if (expansionState.has(stateKey)) expansionState.delete(stateKey);
        else expansionState.add(stateKey);
        render();
      });
      group.append(affordance, el("text", { class: "expand-glyph", x: node.size.width - 14, y: 18, "text-anchor": "middle" }, expanded ? "−" : "+"));
    }
    nodeLayer.append(group);
  });
}

function isExpandableNode(node) {
  return ["IVR", "RingGroup", "Queue", "DID"].includes(node.kind);
}

function expandAllExpansibleNodes(system, target) {
  Object.keys(system.ivrs).forEach((dn) => target.add(`IVR:${dn}`));
  Object.keys(system.ringGroups).forEach((dn) => target.add(`RingGroup:${dn}`));
  Object.keys(system.queues).forEach((dn) => target.add(`Queue:${dn}`));
  system.trunks.forEach((trunk, trunkIndex) => {
    const trunkNumber = trunk.number || trunkIndex;
    trunk.rules.forEach((_, ruleIndex) => target.add(`DID:${trunkNumber}:${ruleIndex}`));
  });
}

function groupByDepth(graph) {
  const { nodes, edges } = graph;
  const maxDepth = Math.max(...nodes.map((node) => node.depth));
  const layers = Array.from({ length: maxDepth + 1 }, () => []);

  const sortedNodes = nodes
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  sortedNodes.forEach((node) => layers[node.depth].push(node));

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const parentsByNode = new Map(nodes.map((node) => [node.id, []]));
  const childrenByNode = new Map(nodes.map((node) => [node.id, []]));

  edges.forEach((edge) => {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);
    if (!from || !to) return;
    if (to.depth === from.depth + 1) {
      parentsByNode.get(to.id).push(from.id);
      childrenByNode.get(from.id).push(to.id);
    } else if (from.depth === to.depth + 1) {
      parentsByNode.get(from.id).push(to.id);
      childrenByNode.get(to.id).push(from.id);
    }
  });

  const maxIterations = 6;
  for (let i = 0; i < maxIterations; i += 1) {
    for (let depth = 1; depth < layers.length; depth += 1) {
      reorderLayer(layers, depth, parentsByNode);
    }
    for (let depth = layers.length - 2; depth >= 0; depth -= 1) {
      reorderLayer(layers, depth, childrenByNode);
    }
  }

  return layers.filter(Boolean);
}

function reorderLayer(layers, depth, relatedByNode) {
  const orderInRefLayer = new Map();
  layers.forEach((layer) => {
    layer.forEach((node, index) => {
      orderInRefLayer.set(node.id, index);
    });
  });

  layers[depth].sort((a, b) => {
    const scoreA = medianRank(relatedByNode.get(a.id), orderInRefLayer);
    const scoreB = medianRank(relatedByNode.get(b.id), orderInRefLayer);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.title.localeCompare(b.title, undefined, { numeric: true });
  });
}

function medianRank(ids, orderLookup) {
  if (!ids || !ids.length) return Number.POSITIVE_INFINITY;
  const ranks = ids
    .map((id) => orderLookup.get(id))
    .filter((rank) => Number.isFinite(rank))
    .sort((a, b) => a - b);

  if (!ranks.length) return Number.POSITIVE_INFINITY;
  const mid = Math.floor(ranks.length / 2);
  if (ranks.length % 2) return ranks[mid];
  return (ranks[mid - 1] + ranks[mid]) / 2;
}

function appendWrappedText(group, lines, x, y, className) {
  const textNode = el("text", { class: className, x, y });
  (lines || [""]).forEach((line, index) => {
    textNode.append(el("tspan", { x, dy: index ? 15 : 0 }, line));
  });
  group.append(textNode);
}

function wrap(value, maxChars) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (!clean) return [""];
  const words = clean.split(" ");
  const lines = [""];
  words.forEach((word) => {
    const current = lines[lines.length - 1];
    if ((current + " " + word).trim().length > maxChars && current) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = (current + " " + word).trim();
    }
  });
  return lines;
}

function renderDetails(system, page, graph, query) {
  details.replaceChildren();
  const showing = query ? `${graph.nodes.length} matching nodes` : `${graph.nodes.length} nodes`;

  details.append(detailCard("Diagram", [
    `${showing} and ${graph.edges.length} links shown.`,
    `Source XML: ${system.sourceEntry}`,
    system.version ? `3CX version: ${system.version}` : "",
  ].filter(Boolean)));

  const selectedTrunk = getSelectedTrunk(system, page);
  const scopedTrunks = selectedTrunk ? [selectedTrunk] : system.trunks;
  const scopedRules = scopedTrunks.flatMap((trunk) => trunk.rules.filter(shouldShowTrunkRule));
  const afterHoursRules = scopedRules.filter((rule) => rule.outOfHours || rule.holidays);

  details.append(detailCard(selectedTrunk ? "Trunk Summary" : "All Trunks Summary", [
    `${scopedTrunks.length} trunk${scopedTrunks.length === 1 ? "" : "s"} shown`,
    `${scopedRules.length} DID rules`,
    `${afterHoursRules.length} rules with after-hours or holiday destinations`,
    `${Object.keys(system.ivrs).length} IVRs`,
    `${Object.keys(system.ringGroups).length} ring groups`,
    `${Object.keys(system.queues).length} queues`,
  ]));

  const cycles = cycleDiagnostics(graph);
  details.append(detailCard("Cycle Diagnostics", [
    cycles.length ? `${cycles.length} cycle${cycles.length === 1 ? "" : "s"} detected` : "No cycles detected",
    ...cycles.map((cycle) => `${cycle.join(" -> ")} -> ${cycle[0]}`),
  ]));
}

function detailCard(title, lines) {
  const card = document.createElement("section");
  card.className = "detail-card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  lines.forEach((line) => {
    const item = document.createElement("li");
    item.textContent = line;
    list.append(item);
  });
  card.append(heading, list);
  return card;
}

function statusForGraph(system, graph, query) {
  if (query) return `Filter active: ${graph.nodes.length} nodes match or connect to "${query}".`;
  const selectedTrunk = getSelectedTrunk(system, currentPage);
  if (selectedTrunk) {
    return `Showing call flow for trunk ${selectedTrunk.number || selectedTrunk.name || "(unnumbered)"}.`;
  }
  return `Showing call flow across ${system.trunks.length} trunks.`;
}


function buildTrunkTabs(system) {
  tabsEl.replaceChildren();

  const allButton = createTab("all-trunks", "All Trunks", currentPage === "all-trunks");
  tabsEl.append(allButton);

  system.trunks.forEach((trunk, index) => {
    const number = String(trunk.number || index + 1);
    const label = trunk.name ? `${trunk.name} (${number})` : `Trunk ${number}`;
    tabsEl.append(createTab(`trunk:${number}`, label, currentPage === `trunk:${number}`));
  });

  const exists = tabsEl.querySelector(`[data-page="${currentPage}"]`);
  if (!exists) currentPage = "all-trunks";
  updatePageHeader();
  setActiveTab(tabsEl.querySelector(`[data-page="${currentPage}"]`));
}

function createTab(page, label, active = false) {
  const button = document.createElement("button");
  button.className = `tab${active ? " is-active" : ""}`;
  button.type = "button";
  button.dataset.page = page;
  button.textContent = label;
  return button;
}

function setActiveHoursTab(activeButton) {
  hoursTabsEl.querySelectorAll(".subtab").forEach((tab) => tab.classList.toggle("is-active", tab === activeButton));
}

function setActiveTab(activeButton) {
  tabsEl.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab === activeButton));
}

function getSelectedTrunk(system, page) {
  if (!page || page === "all-trunks") return null;
  const trunkNumber = page.replace("trunk:", "");
  return system.trunks.find((trunk, index) => String(trunk.number || index + 1) === trunkNumber) || null;
}

function updatePageHeader() {
  if (!currentSystem) return;
  const selectedTrunk = getSelectedTrunk(currentSystem, currentPage);
  if (!selectedTrunk) {
    pageTitle.textContent = "All Trunks";
    pageSubtitle.textContent = `Calls enter from trunks at the top and flow down through ${hoursModeLabel(hoursMode)} destinations.`;
    return;
  }

  const trunkLabel = selectedTrunk.name || `Trunk ${selectedTrunk.number || "(unnumbered)"}`;
  pageTitle.textContent = trunkLabel;
  pageSubtitle.textContent = `Call flow for SIP trunk ${selectedTrunk.number || trunkLabel}, filtered to ${hoursModeLabel(hoursMode)} routes.`;
}

function updateStats(system) {
  document.querySelector("#stat-trunks").textContent = system?.trunks.length || 0;
  document.querySelector("#stat-rules").textContent = system?.trunks.reduce((sum, trunk) => sum + trunk.rules.length, 0) || 0;
  document.querySelector("#stat-ext").textContent = system ? Object.keys(system.extensions).length : 0;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function displayExtension(extension) {
  if (!extension) return "";
  return `${extension.firstName || ""} ${extension.lastName || ""}`.trim() || extension.number || "";
}

function formatExtensionList(members) {
  if (!members.length) return "";
  return Array.from(new Set(members)).join(", ");
}

function getIvrExtensions(system, ivr) {
  if (!ivr) return "";
  const extensionDestinations = [
    ...ivr.options.map((option) => normalizeDestination(option.destination)),
    normalizeDestination(ivr.officeRoute),
    normalizeDestination(ivr.outOfHoursRoute),
  ]
    .filter((dest) => dest?.kind === "Extension")
    .map((dest) => dest.dn);

  return formatExtensionList(extensionDestinations);
}

function hoursModeLabel(mode) {
  if (mode === "office") return "office-hours";
  if (mode === "after") return "after-hours";
  if (mode === "holiday") return "holiday";
  return "office-hours, after-hours, and holiday";
}

function el(tag, attributes = {}, text = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value));
  if (text) node.textContent = text;
  return node;
}


function buildTreeExportHtml(system, graph, page, query) {
  const defaultExpandedDepth = 1;
  const byId = new Map(Array.from(graph.nodes.values()).map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Set();
  graph.edges.forEach((edge) => {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge);
    incoming.add(edge.to);
  });

  const didRoots = Array.from(graph.nodes.values())
    .filter((node) => node.kind === "DID")
    .sort((a, b) => a.title.localeCompare(b.title));
  const exportedAt = new Date().toISOString();

  function nodeCategory(node) {
    const title = `${node?.title || ""} ${node?.sub || ""}`.toLowerCase();
    if (!node) return "none";
    if (node.kind === "VoiceMail") return "voicemail";
    if (node.kind === "Extension" || title.includes("fax")) return "direct";
    if (node.kind === "End" || title.includes("none")) return "none";
    if (node.kind === "RingGroup" || node.kind === "Queue" || node.kind === "IVR") return "main";
    return "other";
  }

  function classifyDid(didNode) {
    const firstEdge = (outgoing.get(didNode.id) || [])[0];
    const firstTarget = firstEdge ? byId.get(firstEdge.to) : null;
    const cat = nodeCategory(firstTarget);
    return cat === "main" ? "main" : cat === "direct" ? "direct" : cat === "voicemail" ? "voicemail" : cat === "none" ? "none" : "other";
  }

  const didRecords = didRoots.map((did) => {
    const firstEdge = (outgoing.get(did.id) || [])[0];
    const firstTarget = firstEdge ? byId.get(firstEdge.to) : null;
    const officeDestination = firstTarget ? `${firstTarget.title} (${firstTarget.kind})` : "None";
    const category = classifyDid(did);
    return { id: did.id, did, category, officeDestination };
  });

  const destinationUsage = new Map();
  didRecords.forEach((record) => {
    const edge = (outgoing.get(record.id) || [])[0];
    const key = edge ? edge.to : "none";
    destinationUsage.set(key, (destinationUsage.get(key) || 0) + 1);
  });
  const mainSharedCount = Array.from(destinationUsage.values()).filter((count) => count > 1).reduce((sum, c) => sum + c, 0);
  const noDestinationCount = didRecords.filter((d) => d.category === "none").length;
  const directCount = didRecords.filter((d) => d.category === "direct").length;

  function collectNotes() {
    const notes = [];
    didRecords.forEach((record) => {
      const edges = outgoing.get(record.id) || [];
      const noDest = edges.length === 0 || record.category === "none";
      if (noDest) notes.push(`DID ${record.did.title} has no destination or routes to None.`);
      const firstEdge = edges[0];
      if (firstEdge && (destinationUsage.get(firstEdge.to) || 0) > 1) {
        notes.push(`DID ${record.did.title} reuses a shared/main route.`);
      }
      if (record.category === "voicemail") notes.push(`DID ${record.did.title} is voicemail-only at office-hours routing.`);
    });
    graph.edges.forEach((edge) => {
      const label = (edge.label || "").toLowerCase();
      const timeoutMatch = label.match(/timeout\s*(\d+)/);
      if (timeoutMatch && Number.parseInt(timeoutMatch[1], 10) >= 45) notes.push(`Long queue timeout detected: "${edge.label}".`);
    });
    notes.push("References to previously rendered nodes are shown to prevent duplicate expansion loops.");
    return notes;
  }

  const reviewNotes = collectNotes();

  function renderNode(nodeId, inPath = new Set(), rendered = new Set(), depth = 0) {
    const node = byId.get(nodeId);
    if (!node) return "";
    if (inPath.has(nodeId)) {
      return `<div class="diag cycle">Cycle detected (${escapeHtml(node.title)} → … → ${escapeHtml(node.title)}).</div>`;
    }
    if (rendered.has(nodeId)) {
      return `<div class="diag ref">Reference to previously rendered node: ${escapeHtml(node.title)}.</div>`;
    }
    rendered.add(nodeId);
    const pathNext = new Set(inPath);
    pathNext.add(nodeId);
    const children = (outgoing.get(nodeId) || []).map((edge) => `<li><div class="edge-row"><span class="edge-label">${escapeHtml(edge.label || "Next")}</span>${renderNode(edge.to, pathNext, rendered, depth + 1)}</div></li>`).join("");
    const sub = node.sub ? `<div class="node-sub">${escapeHtml(node.sub)}</div>` : "";
    const body = `<div class="node-row"><span class="kind-badge kind-${escapeHtml(node.kind.toLowerCase())}">${escapeHtml(node.kind)}</span><strong>${escapeHtml(node.title)}</strong>${sub}</div>`;
    if (!children) return `<div class="leaf">${body}</div>`;
    const openAttr = depth <= defaultExpandedDepth ? " open" : "";
    return `<details class="branch depth-${depth}"${openAttr}><summary>${body}</summary><ul>${children}</ul></details>`;
  }

  const cardsHtml = didRecords.map((record) => {
    const rendered = new Set();
    const tree = renderNode(record.id, new Set(), rendered, 0);
    return `<details class="did-card" open data-did-card data-category="${escapeHtml(record.category)}" data-search="${escapeHtml(`${record.did.title} ${record.did.sub || ""} ${record.officeDestination}`.toLowerCase())}" id="card-${escapeHtml(record.id)}">
      <summary><div class="card-head"><span>${escapeHtml(record.did.title)}</span><span class="route-badge ${escapeHtml(record.category)}">${escapeHtml(record.category)}</span></div></summary>
      <div class="card-meta">${escapeHtml(record.did.sub || "(no label)")} • Office-hours destination: ${escapeHtml(record.officeDestination)}</div>
      <div class="route-tree">${tree}</div>
    </details>`;
  }).join("");

  const overviewRows = didRecords.map((record) => `<tr data-overview-row data-category="${escapeHtml(record.category)}" data-search="${escapeHtml(`${record.did.title} ${record.did.sub || ""} ${record.officeDestination}`.toLowerCase())}">
    <td>${escapeHtml(record.did.title)}</td><td>${escapeHtml(record.did.sub || "")}</td><td>${escapeHtml(record.officeDestination)}</td><td>${record.category === "none" ? "Check destination" : "OK"}</td>
    <td><button type="button" class="view-btn" data-target="card-${escapeHtml(record.id)}">View</button></td>
  </tr>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>3CX Call Routing Tree</title>
<style>
*{box-sizing:border-box}body{font-family:Inter,system-ui,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
.wrap{max-width:1200px;margin:0 auto;padding:16px}.panel{background:#fff;border:1px solid #dbe4ee;border-radius:8px;padding:12px;margin-bottom:12px}
h1{margin:0 0 8px}.meta{color:#475569;font-size:13px}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;margin-top:10px}
.stat{border:1px solid #dbe4ee;border-radius:8px;padding:8px;background:#f8fafc}.toolbar{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
input,select,button{border:1px solid #cbd5e1;border-radius:6px;padding:7px 9px;font-size:14px;background:#fff}button{cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px;border-bottom:1px solid #e2e8f0;text-align:left}
.did-card{border:1px solid #dbe4ee;border-radius:8px;padding:8px;margin-bottom:10px;background:#fff}.card-head{display:flex;justify-content:space-between;gap:8px}
.route-badge{border-radius:999px;padding:2px 8px;font-size:12px;text-transform:capitalize}.route-badge.main{background:#e0f2fe}.route-badge.direct{background:#e2e8f0}.route-badge.voicemail{background:#e0e7ff}.route-badge.none{background:#fee2e2}.route-badge.other{background:#ecfeff}
.node-row{display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}.kind-badge{font-size:11px;padding:2px 6px;border-radius:999px;background:#f1f5f9}
.edge-label{font-weight:600;color:#334155;margin-right:8px}.edge-row{margin:6px 0}.node-sub{color:#64748b;font-size:13px;flex:1 1 100%}
details>summary{list-style:none;cursor:pointer} details>summary::-webkit-details-marker{display:none}
.diag.ref{color:#1d4ed8}.diag.cycle{color:#9a3412}.notes li{margin-bottom:6px}
@media (max-width:700px){.wrap{padding:10px}th:nth-child(2),td:nth-child(2){display:none}}
</style>
</head>
<body>
<div class="wrap">
<section class="panel"><h1>3CX Call Routing Tree</h1><p class="meta">Page: ${escapeHtml(page)} | Filter: ${escapeHtml(query || "(none)")} | Exported: ${escapeHtml(exportedAt)} | Trunks: ${system.trunks.length}</p>
<div class="stats"><div class="stat"><strong>${didRecords.length}</strong><div>DIDs</div></div><div class="stat"><strong>${mainSharedCount}</strong><div>Main/shared route DIDs</div></div><div class="stat"><strong>${directCount}</strong><div>Direct endpoints</div></div><div class="stat"><strong>${noDestinationCount}</strong><div>Need attention (None)</div></div></div></section>
<section class="panel toolbar"><input id="search" placeholder="Search DID, route, extension, queue, IVR, voicemail, person, destination"><select id="route-filter"><option value="all">All routes</option><option value="main">Main/shared route</option><option value="direct">Direct extension or fax</option><option value="voicemail">Voicemail</option><option value="none">No destination</option><option value="other">Other queue/ring group</option></select><button id="expand-all">Expand all</button><button id="collapse-all">Collapse all</button><button id="clear-filters">Clear filters</button></section>
<section class="panel"><h2>DID Overview</h2><table><thead><tr><th>DID</th><th>Label/name</th><th>Office-hours destination</th><th>Result/notes</th><th></th></tr></thead><tbody id="overview-body">${overviewRows}</tbody></table></section>
<section class="panel"><h2>Main Shared Route Summary</h2><p class="meta">Inbound DID(s) → Shared destination → No answer/timeout → IVR/options → final destination (as detected by existing traversal paths).</p></section>
<section class="panel"><h2>Review Notes</h2><ul class="notes">${reviewNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul></section>
<section><h2>Routing Detail Cards</h2>${cardsHtml}</section></div>
<script>
(() => {
  const defaultExpandedDepth = ${defaultExpandedDepth};
  const searchInput = document.querySelector("#search");
  const routeFilter = document.querySelector("#route-filter");
  const cards = Array.from(document.querySelectorAll("[data-did-card]"));
  const rows = Array.from(document.querySelectorAll("[data-overview-row]"));
  const branchDetails = () => Array.from(document.querySelectorAll("details.branch"));
  const applyFilters = () => {
    const q = (searchInput.value || "").trim().toLowerCase();
    const filter = routeFilter.value;
    cards.forEach((card) => {
      const passSearch = !q || (card.dataset.search || "").includes(q);
      const passRoute = filter === "all" || card.dataset.category === filter;
      card.style.display = passSearch && passRoute ? "" : "none";
    });
    rows.forEach((row) => {
      const passSearch = !q || (row.dataset.search || "").includes(q);
      const passRoute = filter === "all" || row.dataset.category === filter;
      row.style.display = passSearch && passRoute ? "" : "none";
    });
  };
  document.querySelector("#expand-all")?.addEventListener("click", () => { document.querySelectorAll("details").forEach((n) => n.open = true); });
  document.querySelector("#collapse-all")?.addEventListener("click", () => {
    branchDetails().forEach((node) => {
      const depthClass = Array.from(node.classList).find((name) => name.startsWith("depth-"));
      const depth = Number.parseInt((depthClass || "depth-0").replace("depth-", ""), 10);
      node.open = depth <= defaultExpandedDepth;
    });
    cards.forEach((card) => { card.open = false; });
  });
  document.querySelector("#clear-filters")?.addEventListener("click", () => { searchInput.value = ""; routeFilter.value = "all"; applyFilters(); });
  searchInput?.addEventListener("input", applyFilters);
  routeFilter?.addEventListener("change", applyFilters);
  document.querySelectorAll(".view-btn").forEach((button) => button.addEventListener("click", () => {
    const target = document.getElementById(button.dataset.target || "");
    if (!target) return;
    target.style.display = "";
    target.open = true;
    target.querySelectorAll("details.branch").forEach((d) => d.open = true);
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  applyFilters();
})();
</script>
</body>
</html>`;
}

function exportDiagramPdf() {
  const legendEnabled = document.querySelector("#pdf-legend")?.checked ?? true;
  const footerEnabled = document.querySelector("#pdf-footer")?.checked ?? true;
  const exportedAt = new Date().toLocaleString();
  const title = pageTitle?.textContent || "Call Routing";
  const subtitle = pageSubtitle?.textContent || "";
  const filterText = searchInput.value.trim() || "(none)";
  const svgMarkup = svg.outerHTML;
  const pageLabel = currentPage === "all-trunks" ? "All Trunks" : currentPage.replace("trunk:", "Trunk ");

  const exportHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Call Routing Diagram PDF Export</title>
<style>
@page { size: landscape; margin: 12mm; }
body { margin: 0; color: #0f172a; font-family: Inter, Segoe UI, Arial, sans-serif; }
.header { border-bottom: 1px solid #cbd5e1; padding-bottom: 8px; margin-bottom: 10px; }
.company { font-weight: 800; letter-spacing: 0.02em; font-size: 14px; }
.meta, .sub { color: #475569; font-size: 11px; }
.sub { margin-top: 4px; }
.diagram { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px; break-inside: avoid; }
.diagram svg { width: 100%; height: auto; background: white; }
.diagram .edge { fill: none; stroke: #8695a1; stroke-width: 2; }
.diagram .edge-office { stroke: #2563eb; }
.diagram .edge-after { stroke: #7c3aed; stroke-dasharray: 7 4; }
.diagram .edge-holiday { stroke: #059669; stroke-dasharray: 7 4; }
.diagram .edge-timeout { stroke: #ea580c; stroke-dasharray: 7 4; }
.diagram .edge-no-answer { stroke: #dc2626; stroke-dasharray: 2.5 3.5; }
.diagram .node-card { fill: #ffffff; stroke: #bdc9d3; stroke-width: 1.5; filter: none; }
.diagram .node-title { fill: #0f172a; font-size: 13px; font-weight: 700; }
.diagram .node-sub { fill: #475569; font-size: 12px; }
.diagram .kind-trunk .node-card { stroke: #0b6ab5; fill: #f0f7fc; }
.diagram .kind-did .node-card { stroke: #d97706; fill: #fff7ed; }
.diagram .kind-ivr .node-card { stroke: #2563eb; fill: #eff6ff; }
.diagram .kind-ringgroup .node-card { stroke: #0f766e; fill: #ecfeff; }
.diagram .kind-queue .node-card { stroke: #7c3aed; fill: #f5f3ff; }
.diagram .kind-extension .node-card { stroke: #475569; fill: #f8fafc; }
.diagram .kind-voicemail .node-card { stroke: #4f46e5; fill: #eef2ff; }
.diagram .kind-external .node-card { stroke: #be185d; fill: #fdf2f8; }
.diagram .kind-endcall .node-card { stroke: #b91c1c; fill: #fef2f2; }
.diagram .edge-label { fill: #334155; font-size: 11px; font-weight: 600; }
.diagram .edge-chip rect { fill: #f8fafc; stroke: #cbd5e1; stroke-width: 1; }
.diagram .edge-chip-office rect { fill: #eff6ff; stroke: #93c5fd; }
.diagram .edge-chip-after rect { fill: #f5f3ff; stroke: #c4b5fd; }
.diagram .edge-chip-holiday rect { fill: #ecfdf5; stroke: #86efac; }
.diagram .edge-chip-timeout rect { fill: #fff7ed; stroke: #fdba74; }
.diagram .edge-chip-no-answer rect { fill: #fef2f2; stroke: #fca5a5; }
.diagram .depth-lane { fill: #f8fafc; }
.diagram .depth-lane-label { fill: #94a3b8; font-size: 11px; font-weight: 700; }
.legend { margin-top: 8px; display: flex; gap: 14px; flex-wrap: wrap; font-size: 10px; color: #334155; }
.legend-item::before { content: ""; display: inline-block; width: 14px; border-top: 2px solid #64748b; margin-right: 5px; transform: translateY(-2px); }
.legend-item.edge-office::before { border-color: #2563eb; }
.legend-item.edge-after::before { border-color: #7c3aed; border-top-style: dashed; }
.legend-item.edge-holiday::before { border-color: #059669; border-top-style: dashed; }
.legend-item.edge-timeout::before { border-color: #ea580c; border-top-style: dashed; }
.legend-item.edge-no-answer::before { border-color: #dc2626; border-top-style: dotted; }
.footer { margin-top: 8px; padding-top: 6px; border-top: 1px solid #cbd5e1; color: #64748b; font-size: 10px; display: flex; justify-content: space-between; }
.page-num::after { content: "Page " counter(page); }
</style>
</head>
<body>
  <div class="header">
    <div class="company">3CX Call Routing Diagram Tool</div>
    <div class="meta">Tenant source: ${escapeHtml(currentSystem.sourceEntry)} | Exported: ${escapeHtml(exportedAt)} | Scope: ${escapeHtml(pageLabel)} | Filter: ${escapeHtml(filterText)}</div>
    <div class="sub">${escapeHtml(title)} — ${escapeHtml(subtitle)}</div>
  </div>
  <div class="diagram">${svgMarkup}</div>
  ${legendEnabled ? `<div class="legend">
    <span class="legend-item edge-office">Office hours</span>
    <span class="legend-item edge-after">After-hours</span>
    <span class="legend-item edge-holiday">Holiday</span>
    <span class="legend-item edge-timeout">Timeout</span>
    <span class="legend-item edge-no-answer">No answer</span>
  </div>` : ""}
  ${footerEnabled ? `<div class="footer"><span>Generated for client/management sharing</span><span class="page-num"></span></div>` : ""}
</body>
</html>`;

  const printFrame = document.createElement("iframe");
  printFrame.setAttribute("aria-hidden", "true");
  printFrame.style.position = "fixed";
  printFrame.style.right = "0";
  printFrame.style.bottom = "0";
  printFrame.style.width = "0";
  printFrame.style.height = "0";
  printFrame.style.border = "0";

  const cleanup = () => {
    setTimeout(() => printFrame.remove(), 500);
  };

  printFrame.onload = () => {
    const frameWindow = printFrame.contentWindow;
    if (!frameWindow) {
      cleanup();
      return;
    }
    frameWindow.focus();
    frameWindow.print();
    cleanup();
  };

  document.body.appendChild(printFrame);
  printFrame.srcdoc = exportHtml;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
