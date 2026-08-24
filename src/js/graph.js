// Render a force-directed graph of documents and tags using d3.js.
// Documents are small circles; tags are larger nodes. Links show:
// - Document -> Tag (documents tagged with that tag)
// - Document -> Document (based on wikilinks)

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

  // Create document nodes from notes index
  for (const [key, path] of Object.entries(linkIndex.notes)) {
    const filePath = String(path);
    const label = filePath.split(/[\\/]/).pop().replace(/\.md$/i, "");
    
    // Extract folder name from path
    const parts = filePath.split(/[\\/]/);
    const folder = parts.length >= 2 ? parts[parts.length - 2] : "";

    // Only include notes inside a folder (at any level) whose name starts
    // with "z_" — the vault's convention for graph/tag-relevant material.
    const inZFolder = parts.slice(0, -1).some((seg) => seg.startsWith("z_"));
    if (!inZFolder) {
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
  // already included as a document node (i.e. inside a "z_" folder), so tags
  // used solely outside those folders don't show up as disconnected nodes.
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

export function renderGraph(container, linkIndex, onDocumentClick) {
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

  // Get container dimensions
  const width = container.clientWidth || 800;
  const height = container.clientHeight || 600;

  // Create controls div
  const controls = document.createElement("div");
  controls.style.position = "absolute";
  controls.style.top = "8px";
  controls.style.right = "8px";
  controls.style.zIndex = "10";
  controls.style.display = "flex";
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
    .force("center", window.d3.forceCenter(width / 2, height / 2))
    .force(
      "collide",
      window.d3.forceCollide().radius((d) => d.radius + 6),
    );

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
    .attr("dy", "0.3em")
    .attr("font-size", "11px")
    .attr("pointer-events", "none")
    .attr("opacity", 0)
    .text((d) => d.label)
    .style("fill", "var(--text-primary)");

  // Hover effects
  nodeElements
    .on("mouseenter", (event, d) => {
      labels.attr("opacity", (node) => (node === d ? 1 : 0));
    })
    .on("mouseleave", () => {
      labels.attr("opacity", 0);
    });

  // Command+click to open document (allows regular click to drag)
  nodeElements.on("click", (event, d) => {
    if ((event.metaKey || event.ctrlKey) && d.type === "document" && onDocumentClick) {
      event.preventDefault();
      onDocumentClick(d.id);
    }
  });

  // Add drag behavior to nodes
  nodeElements.call(
    window.d3
      .drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
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
  simulation.on("tick", () => {
    linkElements
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    nodeElements.attr("cx", (d) => d.x).attr("cy", (d) => d.y);

    labels.attr("x", (d) => d.x).attr("y", (d) => d.y);
  });

  // Fit to screen after simulation settles
  setTimeout(fitToScreen, 500);

  // Cleanup function
  return () => simulation.stop();
}
