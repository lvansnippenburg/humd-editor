// Render a force-directed graph of documents and tags using d3.js.
// Documents are small circles; tags are larger nodes. Links show:
// - Document -> Tag (documents tagged with that tag)
// - Document -> Document (based on wikilinks)

import { splitFrontMatter } from "/js/wysiwyg.js";

// Global variable to store folder color settings (set by main app)
export let graphFolderColors = [
  {folder: "annotations", color: "#52c41a"},
  {folder: "thesis", color: "#e94b3c"},
  {folder: "thoughts", color: "#ffc107"}
];

export function buildGraphData(linkIndex) {
  const nodes = [];
  const links = [];
  const nodeMap = new Map(); // id -> node for quick lookup

  if (!linkIndex || !linkIndex.notes) return { nodes, links };

  // Helper to normalize note references
  function normKey(s) {
    return String(s).split(/[\\/]/).pop().replace(/\.md$/i, "").toLowerCase().trim();
  }

  const vaultRoot = String(linkIndex.vaultPath || "").replace(/\\/g, "/").replace(/\/+$/, "");

  // Create document nodes from notes index
  for (const [key, path] of Object.entries(linkIndex.notes)) {
    const filePath = String(path);
    const label = filePath.split(/[\\/]/).pop().replace(/\.md$/i, "");

    // Extract folder name from path
    const parts = filePath.split(/[\\/]/);
    const folder = parts.length >= 2 ? parts[parts.length - 2] : "";

    // Notes at the top level of the vault aren't part of the graph.
    if (parts.slice(0, -1).join("/") === vaultRoot) {
      continue;
    }

    // graphFolderColors still drives per-folder coloring when configured;
    // folders without an explicit entry fall back to a default color.
    const folderMatch = graphFolderColors.find(config => config.folder === folder);

    const node = {
      id: key,
      label: label || key,
      type: "document",
      radius: 8,
      folder: folder,
      color: folderMatch ? folderMatch.color : "#999",
    };
    nodes.push(node);
    nodeMap.set(key, node);
  }

  // Create tag nodes from tag_index — only for tags with at least one file
  // already included as a document node, so tags used solely at the top level
  // of the vault don't show up as disconnected nodes.
  if (linkIndex.tag_index) {
    for (const [tag, tagData] of Object.entries(linkIndex.tag_index)) {
      const docKeys = (tagData.files || [])
        .map(normKey)
        .filter((docKey) => nodeMap.has(docKey));
      if (docKeys.length === 0) continue;

      const node = {
        id: `tag:${tag}`,
        label: `#${tagData.name || tag}`,
        type: "tag",
        radius: 12,
      };
      nodes.push(node);
      nodeMap.set(node.id, node);

      for (const docKey of docKeys) {
        links.push({
          source: docKey,
          target: node.id,
          type: "tag-link",
          strength: 0.5,
        });
      }
    }
  }

  // Create document-to-document links from backlinks
  if (linkIndex.backlinks) {
    const linkSet = new Set();
    for (const [target, sources] of Object.entries(linkIndex.backlinks)) {
      const tgt = normKey(target);
      if (!nodeMap.has(tgt)) continue;
      for (const source of sources) {
        const src = normKey(source);
        if (!nodeMap.has(src) || src === tgt) continue;
        // Avoid duplicate links (directional)
        const linkId = `${src}->${tgt}`;
        if (linkSet.has(linkId)) continue;
        linkSet.add(linkId);
        links.push({
          source: src,
          target: tgt,
          type: "document-link",
          strength: 1.0,
        });
      }
    }
  }

  return { nodes, links };
}

// The nodes within `steps` steps of `centerId`, following links in both
// directions, and the links between them. Copies, as the simulation changes
// its nodes and links.
export function graphNeighbourhood(nodes, links, centerId, steps) {
  const neighbours = new Map(nodes.map((n) => [n.id, []]));
  for (const { source, target } of links) {
    neighbours.get(source).push(target);
    neighbours.get(target).push(source);
  }
  const reached = new Set([centerId]);
  let frontier = [centerId];
  for (let step = 0; step < steps && frontier.length > 0; step++) {
    const next = [];
    for (const id of frontier) {
      for (const other of neighbours.get(id)) {
        if (!reached.has(other)) {
          reached.add(other);
          next.push(other);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: nodes.filter((n) => reached.has(n.id)).map((n) => ({ ...n })),
    links: links.filter((l) => reached.has(l.source) && reached.has(l.target)).map((l) => ({ ...l })),
  };
}

const PREVIEW_SENTENCES = 5;
const PREVIEW_MAX_CHARS = 700; // for notes without clear sentences

// The first sentences of a note's Markdown, as plain text. Parts that aren't
// running text (front matter, headings, code, tables, footnote definitions,
// comments) are skipped.
export function previewSentences(markdown, count = PREVIEW_SENTENCES) {
  const text = splitFrontMatter(String(markdown).replace(/\r\n?/g, "\n"))
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^ {0,3}(```|~~~)[\s\S]*?^ {0,3}\1.*$/gm, "");
  const blocks = text.split(/\n[ \t]*\n/).flatMap((block) => {
    const lines = block
      .split("\n")
      .filter((l) => !/^ {0,3}(#{1,6}\s|\||\[\^[^\]]+\]:|([-*_][ \t]*){3,}$)/.test(l));
    // List items and quotes are separate pieces of text; other lines wrap.
    const pieces = [];
    for (const line of lines) {
      if (/^\s*([-*+]|\d+[.)])\s/.test(line) || !pieces.length) pieces.push(line);
      else pieces[pieces.length - 1] += ` ${line}`;
    }
    return pieces;
  });
  const segmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const sentences = [];
  for (const block of blocks) {
    const plain = block
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images
      .replace(/\^\[[^\]]*\]|\[\^[^\]]*\]|\[[^\]]*@[^\]]*\]/g, "") // footnotes, citations
      .replace(/\[\[([^\]|]+)\|([^\]]*)\]\]/g, "$2") // [[note|alias]]
      .replace(/\[\[([^\]]+)\]\]/g, "$1") // [[note]]
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // [text](url)
      .replace(/<[^>]+>/g, "")
      .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, "$1") // #tags
      .replace(/^\s*([-*+]|\d+[.)]|>+)\s+/, "")
      .replace(/(\*\*|__|==|~~|[*`])/g, "")
      .replace(/(^|[^\p{L}\p{N}])_([^_]+)_(?![\p{L}\p{N}])/gu, "$1$2") // _italic_
      .replace(/\s+/g, " ")
      .replace(/ ([.,;:!?])/g, "$1") // left by what was taken out
      .trim();
    if (!plain) continue;
    for (const { segment } of segmenter.segment(plain)) {
      sentences.push(segment.trim());
      if (sentences.length === count) break;
    }
    if (sentences.length === count) break;
  }
  const preview = sentences.join(" ");
  return preview.length > PREVIEW_MAX_CHARS ? `${preview.slice(0, PREVIEW_MAX_CHARS).trimEnd()}…` : preview;
}

// The chosen view: kept when the graph is redrawn on returning to its tab.
const graphView = { tag: "", steps: 2 };

// loadNoteText(id) gives a promise for a note's Markdown, for its preview.
export function renderGraph(container, linkIndex, onDocumentClick, loadNoteText) {
  if (!window.d3) {
    console.error("d3.js not loaded");
    return;
  }

  const { nodes, links } = buildGraphData(linkIndex);

  if (nodes.length === 0) {
    const msg = document.createElement("div");
    msg.style.padding = "20px";
    msg.style.textAlign = "center";
    msg.style.color = "#999";
    msg.textContent = "No notes to visualize";
    container.appendChild(msg);
    return;
  }

  // Create controls div
  const controls = document.createElement("div");
  controls.style.position = "absolute";
  controls.style.top = "8px";
  controls.style.right = "8px";
  controls.style.zIndex = "10";
  controls.style.display = "flex";
  controls.style.flexWrap = "wrap";
  controls.style.justifyContent = "flex-end";
  controls.style.alignItems = "center";
  controls.style.gap = "4px";

  const buttonStyle = (btn) => {
    btn.style.padding = "6px 10px";
    btn.style.fontSize = "12px";
    btn.style.border = "1px solid var(--border)";
    btn.style.borderRadius = "4px";
    btn.style.background = "var(--bg-primary)";
    btn.style.color = "var(--text-primary)";
    btn.style.cursor = "pointer";
    btn.style.transition = "background var(--t-fast)";
    btn.onmouseover = () => (btn.style.background = "var(--bg-secondary)");
    btn.onmouseout = () => (btn.style.background = "var(--bg-primary)");
  };

  // The tag to centre on, with its number of notes.
  const tagNodes = nodes
    .filter((n) => n.type === "tag")
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  if (!tagNodes.some((n) => n.id === graphView.tag)) graphView.tag = "";

  const tagSelect = document.createElement("select");
  tagSelect.className = "graph-tag-select";
  tagSelect.title = "Centre the graph on a tag";
  tagSelect.setAttribute("aria-label", "Tag");
  buttonStyle(tagSelect);
  tagSelect.style.maxWidth = "200px";
  tagSelect.add(new Option("All notes", ""));
  for (const tag of tagNodes) {
    const count = links.filter((l) => l.target === tag.id).length;
    tagSelect.add(new Option(`${tag.label} (${count})`, tag.id));
  }
  tagSelect.value = graphView.tag;
  controls.appendChild(tagSelect);

  // The number of steps from the tag: 1 is its notes, 2 also what those notes
  // are related to, and so on.
  const stepsLabel = document.createElement("label");
  stepsLabel.textContent = "Steps";
  stepsLabel.title = "How far to go from the tag: 1 shows its notes, 2 also their other tags and linked notes, and so on";
  stepsLabel.style.display = "flex";
  stepsLabel.style.alignItems = "center";
  stepsLabel.style.gap = "4px";
  stepsLabel.style.marginRight = "4px";
  stepsLabel.style.fontSize = "12px";
  stepsLabel.style.color = "var(--text-primary)";
  const stepsInput = document.createElement("input");
  stepsInput.className = "graph-steps-input";
  stepsInput.type = "number";
  stepsInput.min = "1";
  stepsInput.step = "1";
  stepsInput.value = String(graphView.steps);
  buttonStyle(stepsInput);
  stepsInput.style.width = "56px";
  stepsInput.style.cursor = "text";
  stepsLabel.appendChild(stepsInput);
  controls.appendChild(stepsLabel);

  const zoomInBtn = document.createElement("button");
  zoomInBtn.textContent = "Zoom In";
  buttonStyle(zoomInBtn);
  controls.appendChild(zoomInBtn);

  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.textContent = "Zoom Out";
  buttonStyle(zoomOutBtn);
  controls.appendChild(zoomOutBtn);

  const fitBtn = document.createElement("button");
  fitBtn.textContent = "Fit";
  buttonStyle(fitBtn);
  controls.appendChild(fitBtn);

  container.appendChild(controls);

  let stopDrawing = null;
  const draw = () => {
    stopDrawing?.();
    const shown = graphView.tag
      ? graphNeighbourhood(nodes, links, graphView.tag, graphView.steps)
      : { nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) };
    stopDrawing = drawGraph(container, shown, graphView.tag, onDocumentClick, loadNoteText, {
      zoomInBtn,
      zoomOutBtn,
      fitBtn,
    });
  };

  tagSelect.addEventListener("change", () => {
    graphView.tag = tagSelect.value;
    draw();
  });
  stepsInput.addEventListener("input", () => {
    const steps = parseInt(stepsInput.value, 10);
    if (!(steps >= 1) || steps === graphView.steps) return; // e.g. while retyping
    graphView.steps = steps;
    if (graphView.tag) draw();
  });
  // Don't leave something unusable in the box.
  stepsInput.addEventListener("change", () => {
    stepsInput.value = String(graphView.steps);
  });

  draw();

  // Cleanup function
  return () => stopDrawing();
}

// Draw `nodes` and `links` in a new SVG, in place of the previous one. With
// `centerId`, that node stays in the middle of the view. Returns a function
// that stops the simulation.
function drawGraph(
  container,
  { nodes, links },
  centerId,
  onDocumentClick,
  loadNoteText,
  { zoomInBtn, zoomOutBtn, fitBtn },
) {
  container.querySelector("svg")?.remove();

  // Get container dimensions
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  const centerNode = nodes.find((n) => n.id === centerId);
  if (centerNode) {
    centerNode.radius = 18;
    centerNode.fx = width / 2;
    centerNode.fy = height / 2;
  }

  // Create SVG
  const svg = window.d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height)
    .style("background", "var(--bg-primary)")
    .style("display", "block");

  // Create a group for zooming
  const g = svg.append("g");

  // Create force simulation
  const simulation = window.d3
    .forceSimulation(nodes)
    .force(
      "link",
      window.d3
        .forceLink(links)
        .id((d) => d.id)
        .strength((d) => d.strength)
        .distance(30),
    )
    .force("charge", window.d3.forceManyBody().strength(-150))
    .force(
      "collide",
      window.d3.forceCollide().radius((d) => d.radius + 6),
    );
  // A centred node holds everything in place, as all nodes are connected to it.
  if (!centerNode) simulation.force("center", window.d3.forceCenter(width / 2, height / 2));

  // Add links
  const linkElements = g
    .append("g")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("stroke", (d) => (d.type === "tag-link" ? "#999" : "#e94b3c"))
    .attr("stroke-width", (d) => (d.type === "tag-link" ? 1 : 2))
    .attr("stroke-dasharray", (d) => (d.type === "tag-link" ? "4,4" : "none"))
    .attr("opacity", 0.5);

  // Add nodes
  const nodeElements = g
    .append("g")
    .selectAll("circle")
    .data(nodes)
    .enter()
    .append("circle")
    .attr("r", (d) => d.radius)
    .attr("fill", (d) => {
      if (d.type === "tag") return "#4a90e2";
      return d.color || "#999"; // use node's color, fallback to gray
    })
    .attr("opacity", 0.8)
    .style("cursor", (d) => (d.type === "document" ? "pointer" : "default"));

  // Add labels (shown on hover)
  const labels = g
    .append("g")
    .selectAll("text")
    .data(nodes)
    .enter()
    .append("text")
    .attr("text-anchor", "middle")
    .attr("dy", (d) => (d === centerNode ? `${d.radius + 12}px` : "0.3em"))
    .attr("font-size", "11px")
    .attr("pointer-events", "none")
    .attr("opacity", (d) => (d === centerNode ? 1 : 0))
    .text((d) => d.label)
    .style("fill", "var(--text-primary)");

  const preview = createNotePreview(container, loadNoteText);

  // Hover effects: a tag shows its name, a note a preview.
  nodeElements
    .on("mouseenter", (event, d) => {
      labels.attr("opacity", (node) => ((node === d && d.type === "tag") || node === centerNode ? 1 : 0));
      if (d.type === "document") preview.show(d, event);
    })
    .on("mousemove", (event) => preview.move(event))
    .on("mouseleave", () => {
      labels.attr("opacity", (node) => (node === centerNode ? 1 : 0));
      preview.hide();
    });

  // Command+click or a double-click opens a document (a regular click can
  // start a drag).
  nodeElements.on("click", (event, d) => {
    if ((event.metaKey || event.ctrlKey) && d.type === "document" && onDocumentClick) {
      event.preventDefault();
      onDocumentClick(d.id);
    }
  });
  nodeElements.on("dblclick", (event, d) => {
    if (d.type !== "document" || !onDocumentClick) return;
    event.preventDefault();
    event.stopPropagation(); // keep it from the zoom on double-click
    preview.hide();
    onDocumentClick(d.id);
  });

  // Add drag behavior to nodes
  nodeElements.call(
    window.d3
      .drag()
      .on("start", (event, d) => {
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        // Only now: nodes moving on a mere press would get in the way of a double-click.
        preview.hide();
        simulation.alphaTarget(0.3).restart();
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = d === centerNode ? width / 2 : null;
        d.fy = d === centerNode ? height / 2 : null;
      }),
  );

  // Setup zoom behavior
  const zoom = window.d3
    .zoom()
    .scaleExtent([0.5, 5])
    .on("zoom", (event) => {
      g.attr("transform", event.transform);
    });

  svg.call(zoom);

  // Function to fit all nodes in view
  const fitToScreen = () => {
    if (centerNode) {
      // Keep the centred node in the middle: scale to the farthest node from it.
      const reach = (axis, size) =>
        (2 * Math.max(...nodes.map((n) => Math.abs(n[axis] - centerNode[axis]) + n.radius))) / size;
      const scale = Math.min(2, 0.85 / Math.max(reach("x", width), reach("y", height)));
      svg
        .transition()
        .duration(750)
        .call(
          zoom.transform,
          window.d3.zoomIdentity
            .translate(width / 2 - scale * centerNode.x, height / 2 - scale * centerNode.y)
            .scale(scale),
        );
      return;
    }
    const bounds = g.node().getBBox();
    const fullWidth = bounds.width;
    const fullHeight = bounds.height;
    const midX = bounds.x + fullWidth / 2;
    const midY = bounds.y + fullHeight / 2;

    const scale = 0.85 / Math.max(fullWidth / width, fullHeight / height);
    const translate = [width / 2 - scale * midX, height / 2 - scale * midY];

    svg
      .transition()
      .duration(750)
      .call(
        zoom.transform,
        window.d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale),
      );
  };

  zoomInBtn.onclick = () => {
    svg.transition().call(zoom.scaleBy, 1.3);
  };

  zoomOutBtn.onclick = () => {
    svg.transition().call(zoom.scaleBy, 1 / 1.3);
  };

  fitBtn.onclick = fitToScreen;

  // Update positions on simulation tick
  const updatePositions = () => {
    linkElements
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    nodeElements.attr("cx", (d) => d.x).attr("cy", (d) => d.y);

    labels.attr("x", (d) => d.x).attr("y", (d) => d.y);
  };
  simulation.on("tick", updatePositions);

  if (centerNode) {
    // Show the result of a choice settled, so the fit below is the right one.
    simulation.stop();
    simulation.tick(300);
    updatePositions();
    fitToScreen();
    return () => {
      preview.remove();
      simulation.stop();
    };
  }

  // Fit to screen after simulation settles
  const fitTimer = setTimeout(fitToScreen, 500);

  return () => {
    clearTimeout(fitTimer);
    preview.remove();
    simulation.stop();
  };
}

// The box with a note's name and first sentences, next to the pointer.
function createNotePreview(container, loadNoteText) {
  const el = document.createElement("div");
  el.className = "graph-note-preview";
  el.style.display = "none";
  const name = document.createElement("div");
  name.className = "graph-note-preview-name";
  const text = document.createElement("div");
  text.className = "graph-note-preview-text";
  el.append(name, text);
  container.appendChild(el);

  let timer = null;
  let shownNode = null;
  let pointer = { x: 0, y: 0 };
  const texts = new Map(); // note id -> preview text, while this graph is shown

  const place = () => {
    if (el.style.display === "none") return;
    const gap = 14;
    const margin = 8;
    const { offsetWidth: w, offsetHeight: h } = el;
    let left = pointer.x + gap;
    let top = pointer.y + gap;
    if (left + w > window.innerWidth - margin) left = pointer.x - gap - w;
    if (top + h > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - margin - h);
    el.style.left = `${Math.max(margin, left)}px`;
    el.style.top = `${top}px`;
  };

  const hide = () => {
    clearTimeout(timer);
    shownNode = null;
    el.style.display = "none";
  };

  return {
    show(node, event) {
      hide();
      pointer = { x: event.clientX, y: event.clientY };
      shownNode = node;
      // A short wait, so moving across the graph doesn't read every note on the way.
      timer = setTimeout(async () => {
        name.textContent = node.label;
        text.textContent = texts.get(node.id) || "";
        el.style.display = "block";
        place();
        if (texts.has(node.id) || !loadNoteText) return;
        let preview = "";
        try {
          preview = previewSentences(await loadNoteText(node.id));
        } catch (err) {
          console.warn("Could not read the note for its preview:", err);
          return;
        }
        texts.set(node.id, preview);
        if (shownNode !== node) return;
        text.textContent = preview;
        place();
      }, 200);
    },
    move(event) {
      pointer = { x: event.clientX, y: event.clientY };
      place();
    },
    hide,
    remove() {
      hide();
      el.remove();
    },
  };
}
