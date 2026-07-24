/*
 * app.js
 * ES5 only (var/function, XMLHttpRequest, no fetch/let/const/arrow/template
 * literals) — the CorelDRAW web-docker HTML control uses a legacy IE engine,
 * not Chromium, so we target the lowest common denominator on purpose.
 *
 * Two responsibilities live in this file:
 *   1) Chat UI (render messages, staged attachments, input handling).
 *   2) The CorelDRAW bridge: reading the live selection and executing the
 *      agent's tool calls through window.external.Application, which is the
 *      same automation object model VBA macros use (Shape, Document, Fill,
 *      Curve, ...), just called with JS syntax.
 *
 * Reference for every CorelDRAW call used below (CorelDRAW 2018 = SDK v20):
 *   https://community.coreldraw.com/sdk/api/draw/20/c/shape
 *   https://community.coreldraw.com/sdk/api/draw/20/c/fill
 *   https://community.coreldraw.com/sdk/api/draw/20/m/document.export
 * Verified against official CorelDRAW VBA/COM API reference.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // Input Handling & Expand
  // ---------------------------------------------------------------
  var input = byId("inputText");
  var sendBtn = byId("sendBtn");
  var attachBtn = byId("attachBtn");
  var stopBtn = byId("stopBtn");

  function autoExpand() {
    input.style.height = "auto";
    var newHeight = Math.min(input.scrollHeight, 120);
    input.style.height = newHeight + "px";
  }

  input.addEventListener("input", autoExpand);

  // ---------------------------------------------------------------
  // State
  // ---------------------------------------------------------------

  var shapeRegistry = {}; // ref (string) -> live Shape COM object
  var refCounter = 0;
  var staged = []; // attachments waiting to be sent with the next message
  var busy = false; // true while waiting for a backend round-trip
  var thinkingRow = null; // reference to the typing indicator DOM element

  // ---------------------------------------------------------------
  // Small DOM helpers
  // ---------------------------------------------------------------

  function byId(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) {
      e.className = className;
    }
    if (text) {
      e.appendChild(document.createTextNode(text));
    }
    return e;
  }

  function log(msg) {
    if (window.console && window.console.log) {
      window.console.log(msg);
    }
  }

  function adjustMessagesAlignment() {
    var m = byId("messages");
    var inner = byId("messagesInner");
    var overlay = byId("topFadeOverlay");
    if (!m || !inner) return;

    inner.style.marginTop = "0px";
    var fixedMargin = 130;

    if (overlay) {
      var st = m.scrollTop;
      var opacity = Math.max(0, Math.min(1, st / fixedMargin));
      overlay.style.opacity = opacity;
    }
  }

  var scrollTimer = null;
  var activeUserMsgTop = null;
  var scrollTimer = null;
  var activeUserMsgTop = null;
  var isIE11 = !!window.MSInputMethodContext && !!document.documentMode;

  function scrollToBottom(smooth) {
    adjustMessagesAlignment();
    var m = byId("messages");
    if (!m) return;
    var target;
    var isLocked = activeUserMsgTop !== null && activeUserMsgTop >= 0;

    if (isLocked) {
      target = activeUserMsgTop;
    } else {
      target = m.scrollHeight - m.clientHeight;
    }

    if (target < 0) target = 0;
    if (target <= m.scrollTop && !isLocked) return;
    if (target === m.scrollTop) return;

    // Disabled smooth scroll for IE11 to prevent flicker issues
    if (!smooth || isIE11) {
      m.scrollTop = target;
      return;
    }

    if (scrollTimer) clearInterval(scrollTimer);
    scrollTimer = setInterval(function () {
      var current = m.scrollTop;
      var diff = target - current;
      if (Math.abs(diff) <= 2) {
        m.scrollTop = target;
        clearInterval(scrollTimer);
      } else {
        m.scrollTop =
          current + (diff > 0 ? Math.ceil(diff / 4) : Math.floor(diff / 4));
      }
    }, 15);
  }

  if (window.addEventListener) {
    window.addEventListener("resize", adjustMessagesAlignment);
  } else if (window.attachEvent) {
    window.attachEvent("onresize", adjustMessagesAlignment);
  }

  var msgScrollEl = byId("messages");
  if (msgScrollEl) {
    if (msgScrollEl.addEventListener) {
      msgScrollEl.addEventListener("scroll", adjustMessagesAlignment);
    } else if (msgScrollEl.attachEvent) {
      msgScrollEl.attachEvent("onscroll", adjustMessagesAlignment);
    }
  }
  var scrollTimer = null;
  var activeUserMsgTop = null;
  var isIE11 = !!window.MSInputMethodContext && !!document.documentMode;

  function scrollToBottom(smooth) {
    adjustMessagesAlignment();
    var m = byId("messages");
    if (!m) return;
    var target;
    var isLocked = activeUserMsgTop !== null && activeUserMsgTop >= 0;

    if (isLocked) {
      target = activeUserMsgTop;
    } else {
      target = m.scrollHeight - m.clientHeight;
    }

    if (target < 0) target = 0;
    if (target <= m.scrollTop && !isLocked) return;
    if (target === m.scrollTop) return;

    // Disabled smooth scroll for IE11 to prevent flicker issues
    if (!smooth || isIE11) {
      m.scrollTop = target;
      return;
    }

    if (scrollTimer) clearInterval(scrollTimer);
    scrollTimer = setInterval(function () {
      var current = m.scrollTop;
      var diff = target - current;
      if (Math.abs(diff) <= 2) {
        m.scrollTop = target;
        clearInterval(scrollTimer);
      } else {
        m.scrollTop =
          current + (diff > 0 ? Math.ceil(diff / 4) : Math.floor(diff / 4));
      }
    }, 15);
  }

  function renderMarkdown(text) {
    if (!text) return "";

    var html = text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    html = html.replace(/```([\s\S]*?)```/g, function (match, p1) {
      var lines = p1.split("\n");
      var lang = "";
      if (
        lines.length > 0 &&
        lines[0].trim().length > 0 &&
        lines[0].indexOf(" ") === -1 &&
        lines[0].length < 15
      ) {
        lang = lines[0].trim();
        lines.shift();
      }
      var code = lines.join("\n");
      return (
        '<pre class="code-block' +
        (lang ? " lang-" + lang : "") +
        '"><code>' +
        code.trim() +
        "</code></pre>"
      );
    });

    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/\*\*([\s\S]*?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\*([\s\S]*?)\*/g, "<em>$1</em>");

    html = html.replace(
      /^(#{1,6})\s+(.+)$/gm,
      function (match, hashes, content) {
        var level = hashes.length;
        return "<h" + level + ">" + content + "</h" + level + ">";
      },
    );

    html = html.replace(/^\s*[\-\*]\s+(.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>");
    html = html.replace(/<\/ul>\s*<ul>/g, "");

    var parts = html.split(/(<pre[\s\S]*?<\/pre>)/g);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].indexOf("<pre") !== 0) {
        parts[i] = parts[i].replace(/\n/g, "<br>");
      }
    }
    html = parts.join("");

    html = html.replace(/(<\/(?:h[1-6]|pre|ul|ol|li)>)\s*<br>/g, "$1");
    html = html.replace(/<br>\s*(<(?:h[1-6]|pre|ul|ol|li)>)/g, "$1");

    return html;
  }

  // ---------------------------------------------------------------
  // Networking (XMLHttpRequest — no fetch in the legacy engine)
  // ---------------------------------------------------------------

  var activeStreamRequest = null; // Store reference to current generation HTTP stream

  function postJSONStream(url, data, onChunk, onComplete, onError) {
    var xhr = new XMLHttpRequest();
    activeStreamRequest = xhr;
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");

    var seenBytes = 0;
    var buffer = "";

    xhr.onreadystatechange = function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) {
        if (xhr.status === 200) {
          var text = xhr.responseText || "";
          var newData = text.substring(seenBytes);
          seenBytes = text.length;

          if (newData) {
            buffer += newData;
            var parts = buffer.split("\n");
            buffer = parts.pop();
            var unparsed = "";

            for (var i = 0; i < parts.length; i++) {
              var line = unparsed ? unparsed + parts[i] : parts[i];
              if (line.trim()) {
                try {
                  var payload = JSON.parse(line);
                  onChunk(payload);
                  unparsed = "";
                } catch (e) {
                  unparsed = line + "\n";
                }
              }
            }
            if (unparsed) {
              buffer = unparsed + buffer;
            }
          }
        }
      }
      if (xhr.readyState === 4) {
        if (activeStreamRequest === xhr) activeStreamRequest = null;
        if (xhr.status === 200) {
          if (buffer.trim()) {
            try {
              onChunk(JSON.parse(buffer));
            } catch (e) {}
          }
          if (onComplete) onComplete();
        } else if (xhr.status !== 0) {
          // status 0 is typically abort
          if (onError) onError(new Error("Status " + xhr.status));
        }
      }
    };
    xhr.send(JSON.stringify(data));
  }

  function postJSONStream(url, data, onChunk, onComplete, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    var seenBytes = 0;
    var buffer = "";

    xhr.onreadystatechange = function () {
      if (xhr.readyState === 3 || xhr.readyState === 4) {
        if (xhr.status === 200) {
          var text = xhr.responseText || "";
          var newData = text.substring(seenBytes);
          seenBytes = text.length;
          if (newData) {
            buffer += newData;
            var parts = buffer.split("\n");
            buffer = parts.pop();
            var unparsed = "";
            for (var i = 0; i < parts.length; i++) {
              var line = unparsed ? unparsed + parts[i] : parts[i];
              if (line.trim()) {
                try {
                  var payload = JSON.parse(line);
                  onChunk(payload);
                  unparsed = "";
                } catch (e) {
                  // Saved in case chunk boundary split a multi-byte character or line
                  unparsed = line + "\n";
                }
              }
            }
            if (unparsed) {
              buffer = unparsed + buffer;
            }
          }
        }
      }
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          if (buffer.trim()) {
            try {
              onChunk(JSON.parse(buffer));
            } catch (e) {}
          }
          if (onComplete) onComplete();
        } else {
          if (onError) onError(new Error("Status " + xhr.status));
        }
      }
    };
    xhr.send(JSON.stringify(data));
  }

  function getJSON(url, onOk, onErr) {
    var xhr = new XMLHttpRequest();
    var sep = url.indexOf("?") === -1 ? "?" : "&";
    var bustUrl = url + sep + "_t=" + new Date().getTime();
    xhr.open("GET", bustUrl, true);
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            onOk(JSON.parse(xhr.responseText));
          } catch (e) {
            if (onErr) {
              onErr(e);
            }
          }
        } else if (onErr) {
          onErr(new Error("HTTP " + xhr.status));
        }
      }
    };
    xhr.send();
  }

  // ---------------------------------------------------------------
  // CorelDRAW bridge
  // ---------------------------------------------------------------

  var isCommandGroupOpen = false;

  function isCdrAvailable() {
    try {
      if (window.external && window.external.Application) return true;
      if (window.CorelDRAW && window.CorelDRAW.Application) return true;
      if (typeof CorelDRAW !== "undefined" && CorelDRAW.Application)
        return true;
    } catch (e) {}
    return false;
  }

  // ---------------------------------------------------------------
  // Virtual CorelDRAW Sandbox Engine (Standalone Browser Preview)
  // ---------------------------------------------------------------
  var virtualShapes = [];
  var virtualShapeCounter = 0;
  var isVirtualCanvasOpen = false;

  function updateConnectionStatus() {
    var badge = byId("connectionStatusBadge");
    var text = byId("connectionStatusText");
    var toggleBtn = byId("toggleCanvasBtn");
    if (!badge || !text) return;

    if (isCdrAvailable()) {
      badge.className = "connection-badge connected-mode";
      badge.title = "CorelDRAW 2018 подключён напрямую";
      text.innerText = "CorelDRAW";
      if (toggleBtn) toggleBtn.style.display = "none";
    } else {
      badge.className = "connection-badge standalone-mode";
      badge.title = "Автономная песочница (веб-версия без CorelDRAW)";
      text.innerText = "Web";
      if (toggleBtn) toggleBtn.style.display = "inline-flex";
    }
  }

  function toggleVirtualCanvas(show) {
    var panel = byId("virtualCanvasPanel");
    if (!panel) return;
    if (typeof show === "boolean") {
      isVirtualCanvasOpen = show;
    } else {
      isVirtualCanvasOpen = !isVirtualCanvasOpen;
    }
    panel.style.display = isVirtualCanvasOpen ? "block" : "none";
  }

  function renderVirtualCanvas() {
    var group = byId("virtualCanvasObjectsGroup");
    var countBadge = byId("canvasShapeCount");
    var container = byId("virtualCanvasShapesContainer");
    if (!group) return;

    group.innerHTML = "";
    if (countBadge) {
      countBadge.innerText = virtualShapes.length;
      countBadge.style.display =
        virtualShapes.length > 0 ? "inline-block" : "none";
    }

    if (!container) return;
    if (virtualShapes.length === 0) {
      container.innerHTML =
        '<span class="empty-shapes-hint">Холст пуст. Напишите агенту команду создать фигуру!</span>';
      return;
    }

    container.innerHTML = "";
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      var shape = virtualShapes[i];

      try {
        var parser = new DOMParser();
        var svgDoc = parser.parseFromString(
          '<svg xmlns="http://www.w3.org/2000/svg">' + shape.svg + "</svg>",
          "image/svg+xml",
        );
        var svgNode = svgDoc.documentElement.firstChild;
        if (svgNode) {
          var importedNode = document.importNode(svgNode, true);
          var posX = shape.x || 150;
          var posY = shape.y || 100;
          var rot = shape.angle || 0;
          importedNode.setAttribute(
            "transform",
            "translate(" + posX + ", " + posY + ") rotate(" + rot + ")",
          );
          group.appendChild(importedNode);
        }
      } catch (eSvg) {
        /* fallback */
      }

      var chip = document.createElement("div");
      chip.className = "shape-item-chip";
      chip.title = shape.ref + ": Нажмите чтобы прикрепить";

      var dot = document.createElement("span");
      dot.className = "shape-color-preview";
      dot.style.background = shape.fillColor || "#4da6ff";

      var nameSpan = document.createElement("span");
      nameSpan.innerText = shape.ref + " (" + (shape.name || "SVG") + ")";

      chip.appendChild(dot);
      chip.appendChild(nameSpan);

      (function (s) {
        chip.onclick = function () {
          attachVirtualShape(s);
        };
      })(shape);

      container.appendChild(chip);
    }
  }

  function addVirtualShapeFromSvg(rawSvg, nameHint) {
    virtualShapeCounter += 1;
    var ref = "Shape_" + virtualShapeCounter;

    var fillColor = "#4da6ff";
    var colorMatch = rawSvg.match(/fill=["']([^"']+)["']/i);
    if (colorMatch && colorMatch[1] && colorMatch[1] !== "none") {
      fillColor = colorMatch[1];
    }

    var innerContent = rawSvg.replace(/<\/?svg[^>]*>/gi, "");
    var gSvg = '<g id="' + ref + '">' + innerContent + "</g>";

    var posX = 150 + (((virtualShapeCounter - 1) * 40) % 200);
    var posY = 100 + (((virtualShapeCounter - 1) * 30) % 150);

    var shapeObj = {
      ref: ref,
      name: nameHint || "Объект " + virtualShapeCounter,
      svg: gSvg,
      rawSvg: rawSvg,
      fillColor: fillColor,
      x: posX,
      y: posY,
      width: 50,
      height: 50,
      angle: 0,
    };

    virtualShapes.push(shapeObj);
    renderVirtualCanvas();
    toggleVirtualCanvas(true);
    return shapeObj;
  }

  function updateVirtualShapeFill(targetRef, color) {
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (!targetRef || virtualShapes[i].ref === targetRef) {
        virtualShapes[i].fillColor = color;
        virtualShapes[i].svg = virtualShapes[i].svg.replace(
          /fill=["']([^"']+)["']/g,
          'fill="' + color + '"',
        );
      }
    }
    renderVirtualCanvas();
  }

  function updateVirtualShapePos(targetRef, x, y) {
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (!targetRef || virtualShapes[i].ref === targetRef) {
        virtualShapes[i].x = x;
        virtualShapes[i].y = y;
      }
    }
    renderVirtualCanvas();
  }

  function updateVirtualShapeSize(targetRef, width, height) {
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (!targetRef || virtualShapes[i].ref === targetRef) {
        virtualShapes[i].width = width;
        virtualShapes[i].height = height;
      }
    }
    renderVirtualCanvas();
  }

  function updateVirtualShapeRotation(targetRef, angle) {
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (!targetRef || virtualShapes[i].ref === targetRef) {
        virtualShapes[i].angle = ((virtualShapes[i].angle || 0) + angle) % 360;
      }
    }
    renderVirtualCanvas();
  }

  function deleteVirtualShape(targetRef) {
    var newShapes = [];
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (virtualShapes[i].ref !== targetRef) {
        newShapes.push(virtualShapes[i]);
      }
    }
    virtualShapes = newShapes;
    renderVirtualCanvas();
  }

  function getVirtualShapeSvg(targetRef) {
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (!targetRef || virtualShapes[i].ref === targetRef) {
        return virtualShapes[i].rawSvg;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><circle cx="25" cy="25" r="20" fill="#4da6ff"/></svg>';
  }

  function duplicateVirtualShape(targetRef) {
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (!targetRef || virtualShapes[i].ref === targetRef) {
        return addVirtualShapeFromSvg(
          virtualShapes[i].rawSvg,
          virtualShapes[i].name + " (копия)",
        );
      }
    }
    return null;
  }

  function getVirtualShapeInfo(targetRef) {
    var i;
    for (i = 0; i < virtualShapes.length; i++) {
      if (!targetRef || virtualShapes[i].ref === targetRef) {
        return {
          ref: virtualShapes[i].ref,
          typeName: virtualShapes[i].name,
          width_mm: virtualShapes[i].width,
          height_mm: virtualShapes[i].height,
          x_mm: virtualShapes[i].x,
          y_mm: virtualShapes[i].y,
        };
      }
    }
    return {
      ref: targetRef || "Shape_1",
      typeName: "Shape",
      width_mm: 50,
      height_mm: 50,
      x_mm: 100,
      y_mm: 100,
    };
  }

  function attachVirtualShape(shapeObj) {
    staged.push({
      ref: shapeObj.ref,
      name: shapeObj.name + " (" + shapeObj.ref + ")",
      display_name: shapeObj.name,
      properties: {
        width_mm: shapeObj.width,
        height_mm: shapeObj.height,
        x_mm: shapeObj.x,
        y_mm: shapeObj.y,
        fill_color: shapeObj.fillColor,
      },
      png_path: "",
      svg_path: "",
    });
    renderTray();
  }

  function cdrApp() {
    if (window.external && window.external.Application) {
      return window.external.Application;
    }
    if (window.CorelDRAW && window.CorelDRAW.Application) {
      return window.CorelDRAW.Application;
    }
    if (typeof CorelDRAW !== "undefined" && CorelDRAW.Application) {
      return CorelDRAW.Application;
    }
    throw new Error(
      "CorelDRAW Application API (window.external.Application) недоступен.",
    );
  }

  function activeDoc() {
    try {
      var app = cdrApp();
      return app ? app.ActiveDocument : null;
    } catch (e) {
      return null;
    }
  }

  function refreshCanvas() {
    try {
      cdrApp().Refresh();
    } catch (e) {
      /* best effort */
    }
  }

  function beginUndoGroup(name) {
    if (!isCommandGroupOpen) {
      var doc = activeDoc();
      if (doc) {
        try {
          doc.BeginCommandGroup(name || "AI Agent Actions");
          isCommandGroupOpen = true;
        } catch (e) {
          /* best effort */
        }
      }
    }
  }

  function endUndoGroup() {
    if (isCommandGroupOpen) {
      refreshCanvas();
      var doc = activeDoc();
      if (doc) {
        try {
          doc.EndCommandGroup();
        } catch (e) {
          /* best effort */
        }
      }
      isCommandGroupOpen = false;
    }
  }

  function isOldAiName(name) {
    return /^ai_\d+_\d+$/.test(name) || /^ia_\d+_\d+$/.test(name);
  }

  function generateShortId() {
    var chars = "0123456789abcdef";
    var id;
    do {
      id = "obj_";
      var i;
      for (i = 0; i < 8; i += 1) {
        id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
    } while (shapeRegistry[id]);
    return id;
  }

  // Gives every shape we touch a stable, unique name so we can find it again
  // in a later turn of the conversation (a live COM reference from
  // shapeRegistry is faster, but may not survive undo/redo or a docker reload,
  // so Name is the durable fallback).
  function ensureShapeName(shape) {
    if (!shape) return "";
    var name = "";
    try {
      name = shape.Name;
    } catch (e) {}

    if (!name || name.length === 0 || isOldAiName(name)) {
      name = generateShortId();
      try {
        shape.Name = name;
      } catch (e) {}
    }
    shapeRegistry[name] = shape;
    return name;
  }

  function findShapeByRef(ref) {
    if (shapeRegistry[ref]) {
      return shapeRegistry[ref];
    }
    // Fallback: linear search over the document if the docker was reloaded
    // and the in-memory registry was lost.
    var doc = activeDoc();
    if (!doc) {
      return null;
    }
    var shapes = doc.Shapes;
    var count = shapes.Count;
    var i;
    for (i = 1; i <= count; i += 1) {
      var s = shapes.Item(i);
      if (s.Name === ref) {
        shapeRegistry[ref] = s;
        return s;
      }
    }
    return null;
  }

  function toMillimeters(val, unitCode) {
    if (typeof val !== "number" || isNaN(val)) return 0;
    var factors = {
      1: 25.4, // inches
      2: 304.8, // feet
      3: 914.4, // yards
      4: 1609344, // miles
      5: 1.0, // mm
      6: 10.0, // cm
      7: 1000.0, // m
      8: 1000000.0, // km
      9: 0.3759, // didots
      10: 1.814, // agates
      11: 4.2333, // picas
      12: 0.352778, // pt
      13: 0.264583, // px
      14: 4.512, // ciceros
    };
    var factor = factors[unitCode] || 1.0;
    return Math.round(val * factor * 100) / 100;
  }

  function getShapeTypeName(typeCode) {
    var types = {
      0: "NoShape",
      1: "Rectangle",
      2: "Ellipse",
      3: "Curve",
      4: "Image",
      5: "Text",
      6: "Text",
      7: "Group",
      8: "Selection",
      9: "Guideline",
      11: "Custom",
      12: "Shape",
    };
    return types[typeCode] || "Type_" + typeCode;
  }

  function getUnitName(unitCode) {
    var units = {
      1: "inches",
      2: "feet",
      3: "yards",
      4: "miles",
      5: "mm",
      6: "cm",
      7: "m",
      8: "km",
      9: "didots",
      10: "agates",
      11: "picas",
      12: "pt",
      13: "px",
      14: "ciceros",
    };
    return units[unitCode] || String(unitCode);
  }

  function readShapeProperties(shape) {
    if (!shape) return {};
    var ref = ensureShapeName(shape);
    var typeCode = shape.Type;
    var typeName = getShapeTypeName(typeCode);
    var props = { ref: ref, name: ref, typeCode: typeCode, typeName: typeName };
    var unitCode = 5;
    try {
      var doc = activeDoc();
      if (doc) {
        unitCode = doc.Unit;
        props.docUnit = String(unitCode);
        props.docUnitName = getUnitName(unitCode);
      }
    } catch (e) {}

    try {
      var w = shape.SizeWidth;
      props.width = Math.round(w * 100) / 100;
      props.width_mm = toMillimeters(w, unitCode);
    } catch (e) {}

    try {
      var h = shape.SizeHeight;
      props.height = Math.round(h * 100) / 100;
      props.height_mm = toMillimeters(h, unitCode);
    } catch (e) {}

    try {
      var x = shape.PositionX;
      props.x = Math.round(x * 100) / 100;
      props.x_mm = toMillimeters(x, unitCode);
    } catch (e) {}

    try {
      var y = shape.PositionY;
      props.y = Math.round(y * 100) / 100;
      props.y_mm = toMillimeters(y, unitCode);
    } catch (e) {}

    try {
      if (shape.Text && shape.Text.Story) {
        props.typeName = "Text";
        props.text = shape.Text.Story.Text;
        try {
          props.font = shape.Text.Story.Font;
        } catch (eF) {}
        try {
          props.fontSize = shape.Text.Story.Size;
        } catch (eS) {}
      }
    } catch (e) {}

    try {
      var colors = shape.GetColors();
      props.colors = colorsToArray(colors);
    } catch (e) {}

    try {
      if (shape.Fill && shape.Fill.Type === 1 /* cdrUniformFill */) {
        props.fill_color = colorToHex(shape.Fill.UniformColor);
      } else if (shape.Fill && shape.Fill.Type === 0 /* cdrNoFill */) {
        props.fill_color = "none";
      }
    } catch (eColor) {}

    try {
      if (shape.Outline && shape.Outline.Type !== 0 /* cdrNoOutline */) {
        props.outline_color = colorToHex(shape.Outline.Color);
      } else {
        props.outline_color = "none";
      }
    } catch (eOutline) {}

    props.size_formatted =
      (props.width_mm || 0) +
      " x " +
      (props.height_mm || 0) +
      " мм (" +
      props.width +
      " x " +
      props.height +
      " " +
      (props.docUnitName || "units") +
      ")";
    props.position_formatted =
      "X: " +
      (props.x_mm || 0) +
      " мм, Y: " +
      (props.y_mm || 0) +
      " мм (" +
      props.x +
      ", " +
      props.y +
      " " +
      (props.docUnitName || "units") +
      ")";

    return props;
  }

  function colorsToArray(colorsCollection) {
    var out = [];
    try {
      var n = colorsCollection.Count;
      var i;
      for (i = 1; i <= n; i += 1) {
        var c = colorsCollection.Item(i);
        out.push(colorToHex(c));
      }
    } catch (e) {
      /* best effort only */
    }
    return out;
  }

  function colorToHex(colorObj) {
    try {
      var r = colorObj.RGBRed,
        g = colorObj.RGBGreen,
        b = colorObj.RGBBlue;
      return "#" + toHex2(r) + toHex2(g) + toHex2(b);
    } catch (e) {
      return null;
    }
  }

  function toHex2(n) {
    var h = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return h.length === 1 ? "0" + h : h;
  }

  // Selects exactly one shape without permanently disturbing whatever the
  // user had selected before (best effort — restores the previous selection
  // afterwards).
  function withIsolatedSelection(shape, fn) {
    var doc = activeDoc();
    var prevNames = [];
    try {
      var prevSel = cdrApp().ActiveSelection;
      var i;
      for (i = 1; i <= prevSel.Shapes.Count; i += 1) {
        prevNames.push(prevSel.Shapes.Item(i).Name);
      }
    } catch (e) {}

    try {
      if (doc) {
        doc.DeselectAll();
      }
    } catch (e) {}

    try {
      shape.Selected = true;
      fn();
    } catch (eCore) {
      log("Error inside isolated action: " + eCore.message);
    }

    try {
      doc.DeselectAll();
      var j;
      // Fixed: Graceful, individual try-catch blocks to prevent broken COM references from halting the loop
      for (j = 0; j < prevNames.length; j += 1) {
        try {
          var s = findShapeByRef(prevNames[j]);
          if (s) s.Selected = true;
        } catch (eLoop) {}
      }
    } catch (eRestore) {}
  }

  // Exports the given shape to PNG and SVG at paths the backend already
  // reserved (see /export_paths), so the backend can read both files
  // straight off disk — no binary data ever has to cross the JS boundary.
  function exportShapeAssets(shape, paths, onDone) {
    withIsolatedSelection(shape, function () {
      var doc = activeDoc();
      try {
        // Values confirmed against community.coreldraw.com/sdk/api/draw/20/e/cdrFilter
        // and .../e/cdrExportRange (cdrPNG=802, cdrSVG=1345, cdrSelection=2).
        doc.Export(paths.png_path, 802 /* cdrPNG */, 2 /* cdrSelection */);
        doc.Export(paths.svg_path, 1345 /* cdrSVG */, 2 /* cdrSelection */);
      } catch (e) {
        log("export error: " + e.message);
      }
    });
    onDone();
  }

  // ---------------------------------------------------------------
  // Tool-call execution (the "hands" side of function calling)
  // ---------------------------------------------------------------

  var TOOL_HANDLERS = {
    set_fill_color: function (args, cb) {
      if (!isCdrAvailable()) {
        var color = args.hex_color || (args.cmyk_color ? "#4da6ff" : "#4da6ff");
        updateVirtualShapeFill(args.ref, color);
        cb({ ok: true });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        if (!shape || !shape.Fill) {
          cb({
            error: "Объект не поддерживает заливку (shape.Fill недоступен).",
          });
          return;
        }
        var fill = shape.Fill;
        var c;
        if (args.cmyk_color) {
          var cmyk = args.cmyk_color;
          c = cdrApp().CreateColorEx(
            2 /* cdrColorCMYK */,
            cmyk.c,
            cmyk.m,
            cmyk.y,
            cmyk.k,
          );
        } else if (args.hex_color) {
          var rgb = hexToRgb(args.hex_color);
          c = cdrApp().CreateColorEx(
            1 /* cdrColorRGB */,
            rgb.r,
            rgb.g,
            rgb.b,
            0,
          );
        } else {
          cb({ error: "Не указан цвет (требуется hex_color или cmyk_color)." });
          return;
        }
        fill.ApplyUniformFill(c);
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка применения заливки: " + e.message });
      }
    },

    set_outline: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({ ok: true, style: args.style || "solid" });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        if (!shape || !shape.Outline) {
          cb({
            error: "Объект не поддерживает обводку (shape.Outline недоступен).",
          });
          return;
        }
        var outline = shape.Outline;
        if (args.style === "none") {
          outline.SetProperties(0);
          cb({ ok: true, style: "none" });
          return;
        }
        if (typeof args.width === "number") {
          outline.Width = args.width;
        }
        if (args.cmyk_color) {
          var cmyk = args.cmyk_color;
          var cCmyk = cdrApp().CreateColorEx(
            2 /* cdrColorCMYK */,
            cmyk.c,
            cmyk.m,
            cmyk.y,
            cmyk.k,
          );
          outline.Color = cCmyk;
        } else if (args.hex_color) {
          var rgb = hexToRgb(args.hex_color);
          var cRgb = cdrApp().CreateColorEx(
            1 /* cdrColorRGB */,
            rgb.r,
            rgb.g,
            rgb.b,
            0,
          );
          outline.Color = cRgb;
        }
        if (args.style) {
          var styleMap = { solid: 1, dash: 2, dot: 3, dash_dot: 4 };
          var lineStyle = styleMap[args.style];
          if (lineStyle && outline.Style) {
            try {
              outline.Style = lineStyle;
            } catch (eStyle) {}
          }
        }
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка настройки обводки: " + e.message });
      }
    },

    flip: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({ ok: true, direction: args.direction || "horizontal" });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        if (args.direction === "horizontal") {
          shape.Flip(1 /* cdrFlipHorizontal */);
        } else if (args.direction === "vertical") {
          shape.Flip(2 /* cdrFlipVertical */);
        } else {
          cb({
            error: "Неизвестное направление отзеркаливания: " + args.direction,
          });
          return;
        }
        cb({ ok: true, direction: args.direction });
      } catch (e) {
        cb({ error: "Ошибка отзеркаливания объекта: " + e.message });
      }
    },

    set_position: function (args, cb) {
      if (!isCdrAvailable()) {
        updateVirtualShapePos(args.ref, args.x, args.y);
        cb({
          ok: true,
          x: args.x,
          y: args.y,
          anchor: args.anchor || "top_left",
          unit: "мм",
        });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        var targetX = args.x;
        var targetY = args.y;
        var anchor = args.anchor || "top_left";
        var w = shape.SizeWidth || 0;
        var h = shape.SizeHeight || 0;

        if (anchor === "center") {
          targetX = targetX - w / 2;
          targetY = targetY + h / 2;
        } else if (anchor === "bottom_left") {
          targetY = targetY + h;
        } else if (anchor === "top_right") {
          targetX = targetX - w;
        } else if (anchor === "bottom_right") {
          targetX = targetX - w;
          targetY = targetY + h;
        }

        shape.SetPosition(targetX, targetY);
        var unitName = "";
        try {
          var doc = activeDoc();
          if (doc) {
            unitName = getUnitName(doc.Unit);
          }
        } catch (e) {}
        cb({ ok: true, x: args.x, y: args.y, anchor: anchor, unit: unitName });
      } catch (e) {
        cb({ error: "Ошибка установки позиции: " + e.message });
      }
    },

    set_size: function (args, cb) {
      if (!isCdrAvailable()) {
        updateVirtualShapeSize(args.ref, args.width, args.height);
        cb({ ok: true, width: args.width, height: args.height, unit: "мм" });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        shape.SetSize(args.width, args.height);
        var unitName = "";
        try {
          var doc = activeDoc();
          if (doc) {
            unitName = getUnitName(doc.Unit);
          }
        } catch (e) {}
        cb({
          ok: true,
          width: args.width,
          height: args.height,
          unit: unitName,
        });
      } catch (e) {
        cb({ error: "Ошибка установки размера: " + e.message });
      }
    },

    rotate: function (args, cb) {
      if (!isCdrAvailable()) {
        updateVirtualShapeRotation(args.ref, args.angle);
        cb({ ok: true, angle: args.angle });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        shape.Rotate(args.angle);
        cb({ ok: true, angle: args.angle });
      } catch (e) {
        cb({ error: "Ошибка поворота объекта: " + e.message });
      }
    },

    duplicate: function (args, cb) {
      if (!isCdrAvailable()) {
        var dup = duplicateVirtualShape(args.ref);
        cb({ ok: true, new_ref: dup ? dup.ref : "Shape_1" });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        var copy = shape.Duplicate();
        if (!copy) {
          cb({ error: "Не удалось дублировать объект." });
          return;
        }
        var newRef = ensureShapeName(copy);
        cb({ ok: true, new_ref: newRef });
      } catch (e) {
        cb({ error: "Ошибка дублирования объекта: " + e.message });
      }
    },

    delete_shape: function (args, cb) {
      if (!isCdrAvailable()) {
        deleteVirtualShape(args.ref);
        cb({ ok: true });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        shape.Delete();
        delete shapeRegistry[args.ref];
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка удаления объекта: " + e.message });
      }
    },

    convert_to_curves: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({ ok: true });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        shape.ConvertToCurves();
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка преобразования в кривые: " + e.message });
      }
    },

    remove_fill: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({ ok: true });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        if (shape.Fill) shape.Fill.ApplyNoFill();
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Failed to remove fill: " + e.message });
      }
    },

    weld_shapes: function (args, cb) {
      try {
        if (!args || !args.refs || args.refs.length < 2) {
          cb({ error: "Requires at least 2 shapes to weld." });
          return;
        }
        var sr = cdrApp().CreateShapeRange();
        for (var i = 0; i < args.refs.length; i++) {
          var s = findShapeByRef(args.refs[i]);
          if (s) sr.Add(s);
        }
        if (sr.Count < 2) {
          cb({ error: "Shapes not found for weld." });
          return;
        }

        var welded = sr.Item(1);
        for (var j = 2; j <= sr.Count; j++) {
          welded = welded.Weld(sr.Item(j));
        }
        var newRef = ensureShapeName(welded);
        cb({ ok: true, new_ref: newRef });
      } catch (e) {
        cb({ error: "Weld failed: " + e.message });
      }
    },

    combine_shapes: function (args, cb) {
      try {
        if (!args || !args.refs || args.refs.length < 2) {
          cb({ error: "Requires at least 2 shapes to combine." });
          return;
        }
        var sr = cdrApp().CreateShapeRange();
        for (var i = 0; i < args.refs.length; i++) {
          var s = findShapeByRef(args.refs[i]);
          if (s) sr.Add(s);
        }
        var combined = sr.Combine();
        var newRef = ensureShapeName(combined);
        cb({ ok: true, new_ref: newRef });
      } catch (e) {
        cb({ error: "Combine failed: " + e.message });
      }
    },

    simplify_curve: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({ ok: true });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        var tolerance = args.tolerance || 0.1; // Default tolerance
        if (shape.Curve && shape.Curve.Nodes) {
          shape.Curve.Nodes.All().AutoReduce(tolerance);
          cb({ ok: true });
        } else {
          cb({ error: "Shape is not a valid curve." });
        }
      } catch (e) {
        cb({ error: "Failed to simplify curve: " + e.message });
      }
    },

    order: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({ ok: true });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        var mode = args.mode;
        if (mode === "front") {
          shape.OrderToFront();
        } else if (mode === "back") {
          shape.OrderToBack();
        } else if (mode === "forward") {
          shape.OrderForwardOne();
        } else if (mode === "backward") {
          shape.OrderBackOne();
        } else if (mode === "in_front_of" || mode === "behind") {
          if (!args.target_ref) {
            cb({
              error: "Для режима " + mode + " требуется параметр target_ref.",
            });
            return;
          }
          var targetShape = requireShape(args.target_ref);
          if (mode === "in_front_of") {
            shape.OrderToFrontOf(targetShape);
          } else {
            shape.OrderToBackOf(targetShape);
          }
        } else {
          cb({ error: "Неизвестный режим порядка: " + mode });
          return;
        }
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка изменения порядка элементов: " + e.message });
      }
    },

    export_svg: function (args, cb, backendPaths) {
      if (!isCdrAvailable()) {
        cb({ ok: true, ref: args.ref, svg: getVirtualShapeSvg(args.ref) });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        exportShapeAssets(shape, backendPaths, function () {
          cb({
            ok: true,
            ref: args.ref,
            svg_path: backendPaths.svg_path,
            png_path: backendPaths.png_path,
          });
        });
      } catch (e) {
        cb({ error: "Ошибка экспорта SVG: " + e.message });
      }
    },

    import_svg: function (args, cb) {
      if (!isCdrAvailable()) {
        var svgCode =
          args.raw_svg ||
          args.svg ||
          '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><circle cx="25" cy="25" r="25" fill="#4da6ff"/></svg>';
        var vShape = addVirtualShapeFromSvg(svgCode, "Векторный объект");
        cb({ ok: true, new_ref: vShape.ref });
        return;
      }
      var doc = activeDoc();
      if (!doc) {
        cb({ error: "Нет открытого документа в CorelDRAW." });
        return;
      }
      try {
        var layer = doc.ActiveLayer;
        if (!layer) {
          cb({ error: "Не удалось получить активный слой документа." });
          return;
        }
        var imported = layer.ImportEx(args.svg_path);
        var newRef = null;
        try {
          if (imported && imported.Shapes && imported.Shapes.Count > 0) {
            newRef = ensureShapeName(imported.Shapes.Item(1));
          }
        } catch (e) {
          /* ignore */
        }
        if (
          newRef &&
          typeof args.x === "number" &&
          typeof args.y === "number"
        ) {
          try {
            var target = findShapeByRef(newRef);
            if (target) {
              target.SetPosition(args.x, args.y);
            }
          } catch (e) {
            /* best effort */
          }
        }
        cb({ ok: true, new_ref: newRef });
      } catch (e) {
        cb({ error: "Ошибка импорта SVG: " + e.message });
      }
    },

    replace_shape_svg: function (args, cb) {
      try {
        var oldShape = requireShape(args.ref);
        var posX = oldShape.PositionX;
        var posY = oldShape.PositionY;
        var width = oldShape.SizeWidth;
        var height = oldShape.SizeHeight;
        var preserveSize = args.preserve_size !== false;

        var doc = activeDoc();
        if (!doc) {
          cb({ error: "Нет открытого документа в CorelDRAW." });
          return;
        }
        var layer = doc.ActiveLayer;
        if (!layer) {
          cb({ error: "Не удалось получить активный слой документа." });
          return;
        }
        var imported = layer.ImportEx(args.svg_path);
        var newShape = null;
        if (imported && imported.Shapes && imported.Shapes.Count > 0) {
          newShape = imported.Shapes.Item(1);
        }
        if (!newShape) {
          cb({ error: "Не удалось импортировать новый SVG для замены." });
          return;
        }
        var newRef = ensureShapeName(newShape);
        newShape.SetPosition(posX, posY);
        if (preserveSize && width > 0 && height > 0) {
          newShape.SetSize(width, height);
        }
        try {
          newShape.OrderToFrontOf(oldShape);
        } catch (eOrd) {}
        oldShape.Delete();
        delete shapeRegistry[args.ref];

        cb({ ok: true, new_ref: newRef });
      } catch (e) {
        cb({ error: "Ошибка при замене объекта SVG: " + e.message });
      }
    },

    get_object_info: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({ ok: true, info: getVirtualShapeInfo(args.ref) });
        return;
      }
      try {
        var shape = requireShape(args.ref);
        var info = readShapeProperties(shape);
        cb({ ok: true, info: info });
      } catch (e) {
        cb({ error: "Ошибка получения информации об объекте: " + e.message });
      }
    },

    trace_bitmap: function (args, cb) {
      try {
        var shape = requireShape(args.ref);
        if (!shape || shape.Type !== 4 /* cdrBitmapShape */) {
          cb({
            error:
              "Выбранный объект не является растровым изображением (битмапом). Код типа объекта: " +
              (shape ? shape.Type : "undefined") +
              " (требуется cdrBitmapShape = 4). Пожалуйста, выберите растр для трассировки.",
          });
          return;
        }
        var styleMap = {
          line_art: 1,
          logo: 2,
          detailed_logo: 3,
          clipart: 4,
          low_quality_image: 5,
          high_quality_image: 6,
          technical: 7,
          line_drawing: 8,
        };
        var traceType = styleMap[args.style] || 6;
        var bitmap = shape.Bitmap;
        if (!bitmap) {
          cb({
            error:
              "Объект не содержит растровых данных (shape.Bitmap недоступен).",
          });
          return;
        }
        bitmap.Trace(traceType);
        var newRefs = [];
        try {
          var sel = cdrApp().ActiveSelection;
          if (sel && sel.Shapes) {
            var i;
            for (i = 1; i <= sel.Shapes.Count; i += 1) {
              newRefs.push(ensureShapeName(sel.Shapes.Item(i)));
            }
          }
        } catch (e) {
          /* best effort */
        }
        cb({ ok: true, new_refs: newRefs });
      } catch (e) {
        cb({ error: "Ошибка при трассировке изображения: " + e.message });
      }
    },

    get_page_info: function (args, cb) {
      if (!isCdrAvailable()) {
        cb({
          ok: true,
          width_mm: 210,
          height_mm: 297,
          size_formatted: "A4 (210 x 297 мм) [Песочница Web]",
          unit: "мм",
          shapes_count: virtualShapes.length,
          shapes: virtualShapes,
        });
        return;
      }
      try {
        var doc = activeDoc();
        if (!doc) {
          cb({ error: "Нет открытого документа в CorelDRAW." });
          return;
        }
        var page = doc.ActivePage;
        if (!page) {
          cb({ error: "Не удалось получить активную страницу документа." });
          return;
        }
        var unitCode = doc.Unit;
        var unitName = getUnitName(unitCode);
        var widthDoc = Math.round(page.SizeWidth * 100) / 100;
        var heightDoc = Math.round(page.SizeHeight * 100) / 100;
        var widthMm = toMillimeters(page.SizeWidth, unitCode);
        var heightMm = toMillimeters(page.SizeHeight, unitCode);

        var shapeList = [];
        try {
          var shapes = page.Shapes;
          if (shapes) {
            var count = shapes.Count;
            var i;
            for (i = 1; i <= count; i += 1) {
              var s = shapes.Item(i);
              shapeList.push(readShapeProperties(s));
            }
          }
        } catch (eShapes) {
          /* best effort */
        }

        var info = {
          width: widthDoc,
          height: heightDoc,
          width_mm: widthMm,
          height_mm: heightMm,
          size_formatted:
            widthMm +
            " x " +
            heightMm +
            " мм (" +
            widthDoc +
            " x " +
            heightDoc +
            " " +
            unitName +
            ")",
          unit: unitName,
          unit_code: unitCode,
          shapes_count: shapeList.length,
          shapes: shapeList,
        };
        cb(info);
      } catch (e) {
        cb({
          error: "Ошибка при получении информации о странице: " + e.message,
        });
      }
    },

    set_text: function (args, cb) {
      try {
        var shape = requireShape(args.ref);
        if (!shape || !shape.Text || !shape.Text.Story) {
          cb({
            error:
              "Объект не содержит текстовых данных (shape.Text.Story недоступен).",
          });
          return;
        }
        if (typeof args.text === "string") {
          shape.Text.Story.Text = args.text;
        }
        var textStory = shape.Text.Story;
        if (args.font_name && textStory.Font) {
          try {
            textStory.Font = args.font_name;
          } catch (eF) {}
        }
        if (typeof args.font_size === "number" && textStory.Size) {
          try {
            textStory.Size = args.font_size;
          } catch (eS) {}
        }
        if (args.alignment && textStory.Alignment) {
          var alignMap = { left: 1, center: 2, right: 3, justify: 4 };
          if (alignMap[args.alignment]) {
            try {
              textStory.Alignment = alignMap[args.alignment];
            } catch (eA) {}
          }
        }
        if (args.cmyk_color && textStory.Fill) {
          try {
            var cmyk = args.cmyk_color;
            var cCmyk = cdrApp().CreateColorEx(
              2 /* cdrColorCMYK */,
              cmyk.c,
              cmyk.m,
              cmyk.y,
              cmyk.k,
            );
            textStory.Fill.ApplyUniformFill(cCmyk);
          } catch (eCmyk) {}
        } else if (args.hex_color && textStory.Fill) {
          try {
            var rgb = hexToRgb(args.hex_color);
            var cRgb = cdrApp().CreateColorEx(
              1 /* cdrColorRGB */,
              rgb.r,
              rgb.g,
              rgb.b,
              0,
            );
            textStory.Fill.ApplyUniformFill(cRgb);
          } catch (eRgb) {}
        }
        cb({ ok: true, text: shape.Text.Story.Text });
      } catch (e) {
        cb({ error: "Не удалось изменить текст: " + e.message });
      }
    },

    group_shapes: function (args, cb) {
      try {
        if (!args || !args.refs || !args.refs.length) {
          cb({ error: "Не переданы объекты для группировки." });
          return;
        }
        var sr = cdrApp().CreateShapeRange();
        var i, s;
        for (i = 0; i < args.refs.length; i += 1) {
          s = findShapeByRef(args.refs[i]);
          if (s) {
            sr.Add(s);
          }
        }
        if (sr.Count === 0) {
          cb({ error: "Не найдено объектов для группировки." });
          return;
        }
        var group = sr.Group();
        var newRef = ensureShapeName(group);
        cb({ ok: true, new_ref: newRef });
      } catch (e) {
        cb({ error: "Ошибка при группировке объектов: " + e.message });
      }
    },

    ungroup_shapes: function (args, cb) {
      try {
        var shape = requireShape(args.ref);
        var newRefs = [];
        var unGrouped = null;
        try {
          unGrouped = shape.UngroupEx();
        } catch (e1) {
          try {
            unGrouped = shape.Ungroup();
          } catch (e2) {
            /* ignore */
          }
        }
        if (unGrouped && unGrouped.Count) {
          var i;
          for (i = 1; i <= unGrouped.Count; i += 1) {
            newRefs.push(ensureShapeName(unGrouped.Item(i)));
          }
        }
        cb({ ok: true, new_refs: newRefs });
      } catch (e) {
        cb({ error: "Ошибка при разгруппировке объекта: " + e.message });
      }
    },

    align_objects: function (args, cb) {
      try {
        if (!args || !args.refs || !args.refs.length) {
          cb({ error: "Не переданы объекты для выравнивания." });
          return;
        }
        var sr = cdrApp().CreateShapeRange();
        var i, s;
        for (i = 0; i < args.refs.length; i += 1) {
          s = findShapeByRef(args.refs[i]);
          if (s) {
            sr.Add(s);
          }
        }
        if (sr.Count === 0) {
          cb({ error: "Не найдено объектов для выравнивания." });
          return;
        }

        var hMap = { left: 1, center: 2, right: 3, none: 0 };
        var vMap = { top: 1, center: 2, bottom: 3, none: 0 };
        var relMap = { selection: 0, page: 1 };

        var h = hMap[args.align_h || "none"] || 0;
        var v = vMap[args.align_v || "none"] || 0;
        var rel = relMap[args.relative_to || "selection"] || 0;

        sr.AlignAndDistribute(h, v, rel);
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка выравнивания объектов: " + e.message });
      }
    },

    distribute_objects: function (args, cb) {
      try {
        if (!args || !args.refs || !args.refs.length) {
          cb({ error: "Не переданы объекты для распределения." });
          return;
        }
        var sr = cdrApp().CreateShapeRange();
        var i, s;
        for (i = 0; i < args.refs.length; i += 1) {
          s = findShapeByRef(args.refs[i]);
          if (s) {
            sr.Add(s);
          }
        }
        if (sr.Count === 0) {
          cb({ error: "Не найдено объектов для распределения." });
          return;
        }
        var isH = args.direction === "horizontal";
        var isSpaces = args.mode === "equal_spaces";
        if (isH) {
          sr.AlignAndDistribute(0, 0, 0, isSpaces ? 4 : 2, 0);
        } else {
          sr.AlignAndDistribute(0, 0, 0, 0, isSpaces ? 4 : 2);
        }
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка распределения объектов: " + e.message });
      }
    },
  };

  function requireShape(ref) {
    var s = findShapeByRef(ref);
    if (!s) {
      throw new Error("shape not found for ref: " + ref);
    }
    return s;
  }

  function hexToRgb(hex) {
    if (!hex || typeof hex !== "string") {
      return { r: 0, g: 0, b: 0 };
    }
    var clean = hex.replace("#", "").trim();
    if (clean.length === 3) {
      clean = clean[0] + clean[0] + clean[1] + clean[1] + clean[2] + clean[2];
    }
    return {
      r: parseInt(clean.substring(0, 2), 16) || 0,
      g: parseInt(clean.substring(2, 4), 16) || 0,
      b: parseInt(clean.substring(4, 6), 16) || 0,
    };
  }

  // ---------------------------------------------------------------
  // Chat rendering
  // ---------------------------------------------------------------

  function removeSplash() {
    var s = byId("splashScreen");
    if (s) {
      s.parentNode.removeChild(s);
    }
  }

  function addReasoning(text) {
    if (!text || (typeof text === "string" && text.trim() === "")) {
      return null;
    }
    removeSplash();
    var row = el("div", "msg-row msg-reasoning");
    var box = el("div", "reasoning-box");
    var title = el("div", "reasoning-title", "Рассуждения модели");
    var body = el("div", "reasoning-body");
    body.innerHTML = renderMarkdown(text);
    box.appendChild(title);
    box.appendChild(body);
    row.appendChild(box);
    byId("messagesInner").appendChild(row);
    scrollToBottom();
    return body;
  }

  function addMessage(role, text) {
    if (!text || (typeof text === "string" && text.trim() === "")) {
      return null;
    }
    removeSplash();
    var row = el("div", "msg-row msg-" + role);
    var bubble = el("div", "bubble");
    if (role === "agent" || role === "assistant") {
      bubble.innerHTML = renderMarkdown(text);
    } else {
      var lines = text.split("\n");
      for (var i = 0; i < lines.length; i++) {
        bubble.appendChild(document.createTextNode(lines[i]));
        if (i < lines.length - 1) {
          bubble.appendChild(el("br"));
        }
      }
    }
    row.appendChild(bubble);
    byId("messagesInner").appendChild(row);
    scrollToBottom();
    return bubble;
  }

  function addActionEntry(text, isError) {
    removeSplash();
    var row = el("div", "msg-action" + (isError ? " is-error" : ""));
    var bubble = el("div", "bubble", text);
    row.appendChild(bubble);
    byId("messagesInner").appendChild(row);
    scrollToBottom();
  }

  function formatToolHeaderTitle(name, args) {
    if (!args || typeof args !== "object") args = {};

    var refPrefix = args.ref ? args.ref + " " : "";
    var summary = "";
    switch (name) {
      case "trace_bitmap":
        var styleNameMap = {
          line_art: "Line art",
          logo: "Logo",
          detailed_logo: "Detailed logo",
          clipart: "Clipart",
          low_quality_image: "Low quality image",
          high_quality_image: "High quality image",
          technical: "Technical",
          line_drawing: "Line drawing",
        };
        var styleStr = styleNameMap[args.style] || args.style || "Image";
        summary = "Trace(" + refPrefix + styleStr + ")";
        break;

      case "set_fill_color":
        var colorStr =
          args.hex_color ||
          (args.cmyk_color
            ? "CMYK(" +
              args.cmyk_color.c +
              "," +
              args.cmyk_color.m +
              "," +
              args.cmyk_color.y +
              "," +
              args.cmyk_color.k +
              ")"
            : "color");
        summary = "Fill(" + refPrefix + colorStr + ")";
        break;

      case "set_outline":
        var outColor =
          args.hex_color ||
          (args.cmyk_color
            ? "CMYK(" + args.cmyk_color.c + "," + args.cmyk_color.m + ")"
            : "");
        var outW =
          args.width_mm || args.width
            ? (args.width_mm || args.width) + "mm"
            : "";
        var outStr =
          outW && outColor ? outW + " " + outColor : outW || outColor;
        summary = "Outline(" + refPrefix + outStr + ")";
        break;

      case "flip":
        var dirStr = args.direction === "vertical" ? "Vertical" : "Horizontal";
        summary = "Flip(" + refPrefix + dirStr + ")";
        break;

      case "set_position":
        summary = "Move(" + refPrefix + args.x + ", " + args.y + ")";
        break;

      case "set_size":
        summary = "Resize(" + refPrefix + args.width + "x" + args.height + ")";
        break;

      case "rotate":
        summary = "Rotate(" + refPrefix + args.angle + "°)";
        break;

      case "duplicate":
        summary = "Duplicate(" + (args.ref || "") + ")";
        break;

      case "delete_shape":
        summary = "Delete(" + (args.ref || "") + ")";
        break;

      case "convert_to_curves":
        summary = "Convert to curves(" + (args.ref || "") + ")";
        break;

      case "order":
        var modeMap = {
          front: "Front",
          back: "Back",
          forward: "Forward",
          backward: "Backward",
          in_front_of: "In front of",
          behind: "Behind",
        };
        var modeStr = modeMap[args.mode] || args.mode || "";
        var targetStr = args.target_ref ? " -> " + args.target_ref : "";
        summary = "Order(" + refPrefix + modeStr + targetStr + ")";
        break;

      case "export_svg":
        summary = "Export SVG(" + (args.ref || "") + ")";
        break;

      case "import_svg":
        var svgContent = args.svg_content || args.svg || "";
        var svgLen = svgContent.length;
        var svgHint =
          svgLen > 0
            ? svgLen > 500
              ? Math.round((svgLen / 1024) * 10) / 10 + "kb"
              : svgLen + "b"
            : "";
        var locStr =
          typeof args.x === "number" && typeof args.y === "number"
            ? args.x + ", " + args.y
            : "";
        var svgParts = [];
        if (args.ref) svgParts.push(args.ref);
        if (svgHint) svgParts.push("svg:" + svgHint);
        if (locStr) svgParts.push("@" + locStr);
        summary = "Import SVG(" + svgParts.join(" ") + ")";
        break;

      case "replace_shape_svg":
        summary = "Replace SVG(" + (args.ref || "") + ")";
        break;

      case "get_object_info":
        summary = "Object info(" + (args.ref || "") + ")";
        break;

      case "get_page_info":
        summary = "Page info()";
        break;

      case "set_text":
        var tPreview = args.text || "";
        if (tPreview.length > 20) {
          tPreview = tPreview.substring(0, 17) + "...";
        }
        summary = "Set text(" + refPrefix + '"' + tPreview + '")';
        break;

      case "group_shapes":
        var refsStr = args.refs ? args.refs.join(", ") : "";
        summary = "Group(" + refsStr + ")";
        break;

      case "ungroup_shapes":
        summary = "Ungroup(" + (args.ref || "") + ")";
        break;

      case "align_objects":
        var alignRefs = args.refs ? args.refs.join(", ") + " " : "";
        var alignType = args.align_type || "";
        summary = "Align(" + alignRefs + alignType + ")";
        break;

      case "distribute_objects":
        var distRefs = args.refs ? args.refs.join(", ") + " " : "";
        var distType = args.distribute_type || "";
        summary = "Distribute(" + distRefs + distType + ")";
        break;

      default:
        var formattedName = name.replace(/_/g, " ");
        formattedName =
          formattedName.charAt(0).toUpperCase() + formattedName.slice(1);
        var argKeys = Object.keys(args);
        var simpleArgs = [];
        for (var k = 0; k < argKeys.length; k++) {
          var key = argKeys[k];
          var val = args[key];
          if (key === "ref") {
            simpleArgs.unshift(val); // ref first, without key name
          } else if (key === "refs" && Array.isArray(val)) {
            simpleArgs.unshift(val.join(","));
          } else if (typeof val === "string") {
            var short = val.length > 30 ? val.substring(0, 28) + "…" : val;
            simpleArgs.push(key + "=" + short);
          } else if (typeof val === "number" || typeof val === "boolean") {
            simpleArgs.push(key + "=" + val);
          }
        }
        summary = formattedName + "(" + simpleArgs.join(", ") + ")";
        break;
    }

    var maxHeaderLength = 80;
    if (summary.length > maxHeaderLength) {
      if (summary.endsWith(")")) {
        summary = summary.substring(0, maxHeaderLength - 4) + "…)";
      } else {
        summary = summary.substring(0, maxHeaderLength - 1) + "…";
      }
    }
    return summary;
  }

  function formatHumanReadableResult(name, res) {
    if (!res) return "Успешно выполнено";
    if (typeof res === "string") {
      try {
        res = JSON.parse(res);
      } catch (e) {
        return res;
      }
    }

    if (res.error) {
      return "❌ Ошибка: " + res.error;
    }

    switch (name) {
      case "set_fill_color":
        return "Заливка успешно применена";

      case "set_outline":
        return "Обводка успешно настроена";

      case "flip":
        return (
          "Объект успешно отзеркален" +
          (res.direction ? " (" + res.direction + ")" : "")
        );

      case "set_position":
        if (typeof res.x === "number" && typeof res.y === "number") {
          return "Позиция изменена на (" + res.x + ", " + res.y + ")";
        }
        return "Позиция объекта изменена";

      case "set_size":
        if (typeof res.width === "number" && typeof res.height === "number") {
          return "Размер изменён на " + res.width + " x " + res.height;
        }
        return "Размер объекта изменён";

      case "rotate":
        return (
          "Объект повёрнут на " +
          (res.angle !== undefined ? res.angle + "°" : "")
        );

      case "duplicate":
        return "Создана копия объекта: " + (res.new_ref || "");

      case "delete_shape":
        return "Объект успешно удалён";

      case "convert_to_curves":
        return "Объект преобразован в кривые";

      case "order":
        return "Порядок элементов изменён";

      case "export_svg":
        return "SVG успешно экспортирован";

      case "import_svg":
        return "SVG импортирован. Создан объект: " + (res.new_ref || "");

      case "replace_shape_svg":
        return "Объект заменён на SVG. Новый объект: " + (res.new_ref || "");

      case "trace_bitmap":
        var refs = res.new_refs ? res.new_refs.join(", ") : "";
        return "Трассировка завершена. Созданы объекты: " + (refs || "—");

      case "get_object_info":
        if (res.info) {
          var info = res.info;
          var parts = [];
          if (info.typeName) parts.push("Тип: " + info.typeName);
          if (info.width_mm && info.height_mm)
            parts.push(
              "Размер: " + info.width_mm + "x" + info.height_mm + " мм",
            );
          if (info.x_mm !== undefined && info.y_mm !== undefined)
            parts.push("Позиция: (" + info.x_mm + ", " + info.y_mm + ") мм");
          if (info.ref) parts.push("ref: " + info.ref);
          return parts.join(" | ") || "Информация об объекте получена";
        }
        return "Информация об объекте получена";

      case "get_page_info":
        if (res.shapes_count !== undefined) {
          return (
            "Размер страницы: " +
            (res.size_formatted || res.width_mm + "x" + res.height_mm + " мм") +
            " | Объектов на странице: " +
            res.shapes_count
          );
        }
        return "Информация о странице получена";

      case "set_text":
        return 'Текст изменён: "' + (res.text || "") + '"';

      case "group_shapes":
        return "Объекты сгруппированы в: " + (res.new_ref || "");

      case "ungroup_shapes":
        var uRefs = res.new_refs ? res.new_refs.join(", ") : "";
        return "Разгруппировано. Созданы объекты: " + (uRefs || "—");

      case "align_objects":
        return "Объекты выровнены";

      case "distribute_objects":
        return "Объекты распределены";

      default:
        if (res.ok) return "Операция успешно выполнена";
        return JSON.stringify(res);
    }
  }

  function createToolBlock(name, args) {
    removeSplash();
    var row = el("div", "msg-tool-container");
    var bubble = el("div", "msg-tool-bubble");

    var headerTitle = formatToolHeaderTitle(name, args);
    var header = el("div", "msg-tool-header");
    var title = el("div", "msg-tool-title", headerTitle);
    title.title = headerTitle;
    var toggle = el("div", "msg-tool-toggle", "▼");

    header.appendChild(title);
    header.appendChild(toggle);

    var details = el("div", "msg-tool-details");
    details.style.display = "none";

    var formattedArgsStr =
      args && Object.keys(args).length > 0
        ? JSON.stringify(args, null, 2)
        : "{ }";

    var currentResultText = "Выполняется...";
    var currentIsError = false;

    function renderDetails() {
      details.innerHTML = "";

      var argsHeader = el("div", "msg-tool-section-title", "Аргументы:");
      var argsCode = el("pre", "msg-tool-code", formattedArgsStr);

      var resHeader = el("div", "msg-tool-section-title", "Результат:");
      var resContent = el(
        "div",
        "msg-tool-res-text" + (currentIsError ? " is-error" : ""),
        currentResultText,
      );

      details.appendChild(argsHeader);
      details.appendChild(argsCode);
      details.appendChild(resHeader);
      details.appendChild(resContent);
    }

    renderDetails();

    header.onclick = function () {
      if (details.style.display === "none") {
        details.style.display = "block";
        header.className = "msg-tool-header open";
      } else {
        details.style.display = "none";
        header.className = "msg-tool-header";
      }
    };

    bubble.appendChild(header);
    bubble.appendChild(details);
    row.appendChild(bubble);
    byId("messagesInner").appendChild(row);
    scrollToBottom();

    return {
      setResult: function (resStr, isError) {
        currentIsError = isError;
        if (isError) {
          bubble.className = "msg-tool-bubble is-error";
          details.style.display = "block";
          header.className = "msg-tool-header open";
          currentResultText = "❌ " + resStr;
        } else {
          currentResultText = formatHumanReadableResult(name, resStr);
        }
        renderDetails();
        scrollToBottom();
      },
    };
  }

  function addAttachmentBubble(attachment) {
    removeSplash();
    var row = el("div", "msg-row msg-user");
    var card = buildAttachCard(attachment, false);
    row.appendChild(card);
    byId("messagesInner").appendChild(row);
    scrollToBottom();
  }

  function getHumanReadableObjectName(a) {
    if (!a) return "Object";
    if (a.display_name) return a.display_name;
    var props = a.properties || {};
    var typeCode = props.typeCode;
    var typeName = props.typeName;

    if (a.ref === "custom") {
      var name = a.name || "";
      if (
        /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name) ||
        (props.type && props.type.indexOf("image/") === 0)
      ) {
        return "Image";
      }
      return name || "File";
    }

    if (typeCode === 4 || typeName === "Image" || typeName === "Bitmap") {
      return "Image";
    }
    if (typeCode === 1 || typeName === "Rectangle") {
      return "Rectangle";
    }
    if (typeCode === 2 || typeName === "Ellipse") {
      return "Ellipse";
    }
    if (typeCode === 5 || typeCode === 6 || typeName === "Text") {
      return "Text";
    }
    if (typeCode === 7 || typeName === "Group") {
      return "Group";
    }
    if (typeCode === 3 || typeName === "Curve") {
      return "Curve";
    }
    if (
      typeCode === 12 ||
      typeName === "Shape" ||
      typeName === "PerfectShape"
    ) {
      return "Shape";
    }

    if (typeName && typeName !== "NoShape") {
      return typeName;
    }

    return "Object";
  }

  function buildAttachCard(a, removable) {
    var card = el("div", "attach-card");
    var thumb = el("div", "thumb");
    if (a.png_path) {
      thumb.style.backgroundImage =
        "url(/temp_image?path=" + encodeURIComponent(a.png_path) + ")";
    }
    var humanType = getHumanReadableObjectName(a);
    var tag = el("span", "tag", humanType);
    var displayLabel =
      a.ref && a.ref !== "custom"
        ? humanType + " (" + a.ref + ")"
        : a.name || humanType;
    var label = el("div", "label", displayLabel);
    card.title =
      a.ref && a.ref !== "custom"
        ? humanType + " [" + a.ref + "]"
        : displayLabel;
    card.appendChild(thumb);
    card.appendChild(tag);
    card.appendChild(label);
    if (removable) {
      var rm = el("div", "remove", "x");
      rm.onclick = function () {
        removeStaged(a.ref);
      };
      card.appendChild(rm);
    }
    return card;
  }

  function renderTray() {
    var tray = byId("attachTray");
    tray.innerHTML = "";
    if (staged.length === 0) {
      tray.className = "empty";
      return;
    }
    tray.className = "";
    var i;
    for (i = 0; i < staged.length; i += 1) {
      tray.appendChild(buildAttachCard(staged[i], true));
    }
  }

  function removeStaged(ref) {
    var next = [];
    var i;
    for (i = 0; i < staged.length; i += 1) {
      if (staged[i].ref !== ref) {
        next.push(staged[i]);
      }
    }
    staged = next;
    renderTray();
  }

  function setBusy(v) {
    busy = v;
    var sendBtn = byId("sendBtn");
    var stopBtn = byId("stopBtn");
    if (v) {
      sendBtn.style.display = "none";
      stopBtn.style.display = "flex";
    } else {
      sendBtn.style.display = "flex";
      stopBtn.style.display = "none";
    }
    sendBtn.disabled = v;
    if (v) {
      if (!thinkingRow) {
        removeSplash();
        thinkingRow = el("div", "msg-row msg-agent");
        var bubble = el("div", "bubble");
        bubble.appendChild(el("span", "typing-dot"));
        bubble.appendChild(el("span", "typing-dot"));
        bubble.appendChild(el("span", "typing-dot"));
        thinkingRow.appendChild(bubble);
        byId("messagesInner").appendChild(thinkingRow);
        scrollToBottom();
      }
    } else {
      if (thinkingRow && thinkingRow.parentNode) {
        thinkingRow.parentNode.removeChild(thinkingRow);
      }
      thinkingRow = null;
    }
  }

  // ---------------------------------------------------------------
  // Attach flow: capture current CorelDRAW selection into `staged`
  // ---------------------------------------------------------------

  // --- Custom file upload ---
  function uploadCustomFile(file) {
    var formData = new FormData();
    formData.append("file", file, file.name || "pasted_image.png");

    var xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload_attachment", true);
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var res = JSON.parse(xhr.responseText);
          var isImg =
            /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(res.name) ||
            (file.type && file.type.indexOf("image/") === 0);
          var humanType = isImg ? "Image" : "File";
          staged.push({
            ref: "custom",
            name: res.name,
            display_name: humanType,
            properties: {
              type: file.type || "file",
              size: file.size,
              typeName: humanType,
            },
            png_path: res.png_path,
            svg_path: null,
          });
          renderTray();
        } catch (e) {
          addActionEntry("Ошибка разбора ответа: " + e.message, true);
        }
      } else {
        addActionEntry("Ошибка загрузки файла", true);
      }
    };
    xhr.onerror = function () {
      addActionEntry("Сетевая ошибка при загрузке файла", true);
    };
    xhr.send(formData);
  }

  var customFileInput = null;
  function triggerCustomFileUpload() {
    if (!customFileInput) {
      customFileInput = document.createElement("input");
      customFileInput.type = "file";
      customFileInput.multiple = true;
      customFileInput.style.display = "none";
      customFileInput.onchange = function (e) {
        var files = e.target.files;
        if (!files) return;
        var i;
        for (i = 0; i < files.length; i += 1) {
          uploadCustomFile(files[i]);
        }
        customFileInput.value = "";
      };
      document.body.appendChild(customFileInput);
    }
    customFileInput.click();
  }

  // Base64 to Blob helper for IE11
  function dataURItoBlob(dataURI) {
    var parts = dataURI.split(",");
    var byteString = atob(parts[1]);
    var mimeString = parts[0].split(":")[1].split(";")[0];
    var ab = new ArrayBuffer(byteString.length);
    var ia = new Uint8Array(ab);
    var i;
    for (i = 0; i < byteString.length; i += 1) {
      ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeString });
  }

  var isIE11 = !!window.MSInputMethodContext && !!document.documentMode;
  var pasteCatcher = null;

  if (isIE11) {
    pasteCatcher = document.createElement("div");
    pasteCatcher.setAttribute("contenteditable", "true");
    pasteCatcher.style.position = "fixed";
    pasteCatcher.style.top = "0px";
    pasteCatcher.style.left = "-9999px";
    pasteCatcher.style.width = "1px";
    pasteCatcher.style.height = "1px";
    pasteCatcher.style.overflow = "hidden";
    document.body.appendChild(pasteCatcher);

    document.addEventListener("keydown", function (e) {
      if (e.ctrlKey && (e.keyCode === 86 || e.key === "v" || e.key === "V")) {
        var active = document.activeElement;

        var start = 0,
          end = 0,
          hasSelection = false;
        if (active && typeof active.selectionStart !== "undefined") {
          start = active.selectionStart;
          end = active.selectionEnd;
          hasSelection = true;
        }

        pasteCatcher.focus();

        setTimeout(function () {
          var child = pasteCatcher.firstChild;
          var foundImage = false;
          while (child) {
            if (child.tagName === "IMG") {
              var src = child.src;
              if (src.indexOf("data:image") === 0) {
                var blob = dataURItoBlob(src);
                blob.name = "pasted_image.png";
                uploadCustomFile(blob);
                foundImage = true;
              }
            }
            child = child.nextSibling;
          }

          if (!foundImage) {
            // Restore text
            var pastedText = pasteCatcher.innerText || pasteCatcher.textContent;
            if (pastedText && active && hasSelection) {
              var text = active.value || "";
              active.value =
                text.substring(0, start) + pastedText + text.substring(end);
              active.selectionStart = active.selectionEnd =
                start + pastedText.length;
            }
          }

          pasteCatcher.innerHTML = "";
          if (active) active.focus();
        }, 50);
      }
    });
  }

  // Handle Ctrl+V paste (Modern browsers)
  document.addEventListener("paste", function (e) {
    if (isIE11) return; // Handled by keydown hack above

    var clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;

    var i, file;
    if (clipboardData.items) {
      for (i = 0; i < clipboardData.items.length; i += 1) {
        if (clipboardData.items[i].kind === "file") {
          file = clipboardData.items[i].getAsFile();
          if (file) {
            uploadCustomFile(file);
          }
        }
      }
    } else if (clipboardData.files && clipboardData.files.length > 0) {
      for (i = 0; i < clipboardData.files.length; i += 1) {
        uploadCustomFile(clipboardData.files[i]);
      }
    }
  });

  function attachCurrentSelection() {
    if (!isCdrAvailable()) {
      if (virtualShapes && virtualShapes.length > 0) {
        attachVirtualShape(virtualShapes[virtualShapes.length - 1]);
        toggleVirtualCanvas(true);
      } else {
        triggerCustomFileUpload();
      }
      return;
    }

    var sel;
    try {
      sel = cdrApp().ActiveSelectionRange;
    } catch (e) {
      if (virtualShapes && virtualShapes.length > 0) {
        attachVirtualShape(virtualShapes[virtualShapes.length - 1]);
        toggleVirtualCanvas(true);
      } else {
        triggerCustomFileUpload();
      }
      return;
    }

    if (!sel || sel.Count === 0) {
      triggerCustomFileUpload();
      return;
    }

    var i;
    for (i = 1; i <= sel.Count; i += 1) {
      (function (shape) {
        var ref = ensureShapeName(shape);
        var props = readShapeProperties(shape);
        var humanType = getHumanReadableObjectName({
          ref: ref,
          properties: props,
        });
        getJSON(
          "/export_paths",
          function (paths) {
            exportShapeAssets(shape, paths, function () {
              staged.push({
                ref: ref,
                name: humanType + " (" + ref + ")",
                display_name: humanType,
                properties: props,
                png_path: paths.png_path,
                svg_path: paths.svg_path,
              });
              renderTray();
            });
          },
          function (err) {
            addActionEntry("Ошибка экспорта: " + err.message, true);
          },
        );
      })(sel.Item(i));
    }
  }

  function updateSelectionHint() {
    // Disabled to remove top right UI elements
  }

  function registerSelectionListener() {
    try {
      // Docker-specific bridge call documented by Corel for Web Dockers.
      window.external.RegisterEventListener(
        "SelectionChange",
        "onSelectionChange()",
      );
    } catch (e) {
      log("RegisterEventListener unavailable: " + e.message);
    }
  }

  function unregisterSelectionListener() {
    try {
      if (window.external && window.external.UnregisterEventListener) {
        window.external.UnregisterEventListener(
          "SelectionChange",
          "onSelectionChange()",
        );
      }
    } catch (e) {
      /* best effort */
    }
  }

  window.onbeforeunload = function () {
    endUndoGroup();
    unregisterSelectionListener();
  };

  window.onunload = function () {
    endUndoGroup();
    unregisterSelectionListener();
  };

  // called by name from RegisterEventListener above
  window.onSelectionChange = function () {
    updateSelectionHint();
  };

  // ---------------------------------------------------------------
  // Send flow
  // ---------------------------------------------------------------

  function streamBackendResponse(url, data, onDone) {
    setBusy(true);
    var currentBubble = null;
    var currentText = "";
    var reasoningBody = null;
    var reasoningText = "";

    postJSONStream(
      url,
      data,
      function (chunk) {
        setBusy(false);

        if (chunk.type === "thought") {
          reasoningText += chunk.text;
          if (!reasoningBody) {
            reasoningBody = addReasoning(reasoningText);
          } else {
            reasoningBody.innerHTML = renderMarkdown(reasoningText);
            scrollToBottom(true);
          }
        } else if (chunk.type === "chunk") {
          currentText += chunk.text;
          if (!currentBubble) {
            currentBubble = addMessage("agent", currentText);
            if (currentBubble && currentBubble.parentNode) {
              currentBubble.parentNode.className += " generating";
              adjustMessagesAlignment();
            }
          } else {
            currentBubble.innerHTML = renderMarkdown(currentText);
            scrollToBottom(true);
          }
        } else if (chunk.type === "tool_calls") {
          runToolCallsSequentially(chunk.calls, 0, onDone);
        } else if (chunk.type === "error") {
          endUndoGroup();
          addActionEntry("Ошибка API: " + chunk.error, true);
        }
      },
      function () {
        setBusy(false);
        endUndoGroup();
        var inner = byId("messagesInner");
        var m = byId("messages");
        if (inner && m) {
          var currentScrollTop = m.scrollTop;
          var paddingVal = parseFloat(inner.style.paddingBottom) || 0;
          var innerHWithoutPadding = inner.offsetHeight - paddingVal;
          var maxScrollTop = innerHWithoutPadding - m.clientHeight;
          var requiredPadding = 0;
          if (currentScrollTop > 0 && currentScrollTop > maxScrollTop) {
            requiredPadding = currentScrollTop - maxScrollTop;
          }
          inner.style.paddingBottom = Math.max(0, requiredPadding) + "px";
        }
        activeUserMsgTop = null;
        if (currentBubble && currentBubble.parentNode) {
          currentBubble.parentNode.className =
            currentBubble.parentNode.className.replace(" generating", "");
        }
        adjustMessagesAlignment();
        if (onDone) onDone();
      },
      function (err) {
        setBusy(false);
        endUndoGroup();
        var inner = byId("messagesInner");
        var m = byId("messages");
        if (inner && m) {
          var currentScrollTop = m.scrollTop;
          var paddingVal = parseFloat(inner.style.paddingBottom) || 0;
          var innerHWithoutPadding = inner.offsetHeight - paddingVal;
          var maxScrollTop = innerHWithoutPadding - m.clientHeight;
          var requiredPadding = 0;
          if (currentScrollTop > 0 && currentScrollTop > maxScrollTop) {
            requiredPadding = currentScrollTop - maxScrollTop;
          }
          inner.style.paddingBottom = Math.max(0, requiredPadding) + "px";
        }
        activeUserMsgTop = null;
        if (currentBubble && currentBubble.parentNode) {
          currentBubble.parentNode.className =
            currentBubble.parentNode.className.replace(" generating", "");
        }
        adjustMessagesAlignment();
        addActionEntry("Backend недоступен: " + err.message, true);
        if (onDone) onDone();
      },
    );
  }

  function sendMessage() {
    var input = byId("inputText");
    var text = input.value;
    if ((!text || text.trim() === "") && staged.length === 0) {
      return;
    }
    if (busy) {
      return;
    }

    var userBubble = null;
    if (text && text.trim() !== "") {
      userBubble = addMessage("user", text);
    }
    var i;
    for (i = 0; i < staged.length; i += 1) {
      addAttachmentBubble(staged[i]);
    }

    var currentStaged = staged;

    input.value = "";
    staged = [];
    renderTray();

    setTimeout(function () {
      if (userBubble && userBubble.parentNode) {
        var row = userBubble.parentNode;
        var inner = byId("messagesInner");
        var m = byId("messages");
        if (inner && m) {
          var targetScrollTop = Math.max(0, row.offsetTop - 130);
          var clientH = m.clientHeight;
          var paddingVal = parseFloat(inner.style.paddingBottom) || 0;
          var innerHWithoutPadding = inner.offsetHeight - paddingVal;
          var maxScrollTop = innerHWithoutPadding - clientH;
          var requiredPadding = 0;
          if (targetScrollTop > 0 && targetScrollTop > maxScrollTop) {
            requiredPadding = targetScrollTop - maxScrollTop;
          }

          inner.style.paddingBottom = Math.max(0, requiredPadding) + "px";
          activeUserMsgTop = targetScrollTop;
          scrollToBottom(false);
        }
      } else {
        activeUserMsgTop = null;
      }
      streamBackendResponse(
        "/tool_result",
        { tool_call_id: call.id, result: result, chat_id: currentChatId },
        function () {
          runToolCallsSequentially(calls, index + 1, onAllDone);
        },
      );
    }, 20);
  }

  function runToolCallsSequentially(calls, index, onAllDone) {
    if (index === 0 && calls && calls.length > 0) {
      beginUndoGroup("AI Agent Actions");
    }

    if (index >= calls.length) {
      endUndoGroup();
      if (onAllDone) onAllDone();
      return;
    }
    var call = calls[index];
    var toolBlock = createToolBlock(call.name, call.arguments);

    function finish(result) {
      var isError = !!result.error;
      var resultText = isError ? result.error : JSON.stringify(result);
      toolBlock.setResult(resultText, isError);
      streamBackendResponse(
        "/tool_result",
        { tool_call_id: call.id, result: result, chat_id: currentChatId },
        function () {
          runToolCallsSequentially(calls, index + 1, onAllDone);
        },
      );
    }

    var handler = TOOL_HANDLERS[call.name];
    if (!handler) {
      finish({ error: "Неизвестный инструмент: " + call.name });
      return;
    }

    // Special logic for tools that need path resolution first. Every branch
    // below is wrapped so that a thrown exception (e.g. requireShape() not
    // finding the ref) or a failed network round-trip reports an error and
    // moves the loop on, instead of leaving the backend waiting forever for
    // a /tool_result that never arrives.
    if (call.name === "export_svg") {
      getJSON(
        "/export_paths",
        function (paths) {
          try {
            handler(call.arguments, finish, paths);
          } catch (e) {
            finish({ error: "JS Исключение: " + e.message });
          }
        },
        function (err) {
          finish({ error: "Не удалось получить export_paths: " + err.message });
        },
      );
      return;
    }

    if (call.name === "import_svg" || call.name === "replace_shape_svg") {
      postJSON(
        "/prepare_import",
        { svg: call.arguments.svg },
        function (prep) {
          var argsWithPath = {
            ref: call.arguments.ref,
            svg_path: prep.path,
            x: call.arguments.x,
            y: call.arguments.y,
            preserve_size: call.arguments.preserve_size,
          };
          try {
            handler(argsWithPath, finish);
          } catch (e) {
            finish({ error: "JS Исключение: " + e.message });
          }
        },
        function (err) {
          finish({
            error: "Не удалось выполнить prepare_import: " + err.message,
          });
        },
      );
      return;
    }

    try {
      handler(call.arguments, finish);
    } catch (e) {
      finish({ error: "JS Исключение: " + e.message });
    }
  }

  // ---------------------------------------------------------------
  // Backend health check
  // ---------------------------------------------------------------

  function pollHealth() {
    getJSON(
      "/health",
      function () {
        // byId('statusDot').className = 'online';
      },
      function () {
        // byId('statusDot').className = '';
      },
    );
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  function init() {
    updateConnectionStatus();

    var toggleCanvasBtn = byId("toggleCanvasBtn");
    if (toggleCanvasBtn) {
      toggleCanvasBtn.onclick = function () {
        toggleVirtualCanvas();
      };
    }

    var closeCanvasBtn = byId("closeVirtualCanvasBtn");
    if (closeCanvasBtn) {
      closeCanvasBtn.onclick = function () {
        toggleVirtualCanvas(false);
      };
    }

    var clearCanvasBtn = byId("clearVirtualCanvasBtn");
    if (clearCanvasBtn) {
      clearCanvasBtn.onclick = function () {
        virtualShapes = [];
        renderVirtualCanvas();
      };
    }

    // Prompt chips handler
    var chips = document.querySelectorAll(".prompt-chip");
    if (chips) {
      var i;
      for (i = 0; i < chips.length; i += 1) {
        (function (chip) {
          chip.onclick = function () {
            var promptText = chip.getAttribute("data-prompt");
            if (promptText) {
              byId("inputText").value = promptText;
              autoExpand();
              sendMessage();
            }
          };
        })(chips[i]);
      }
    }

    byId("attachBtn").onclick = attachCurrentSelection;
    byId("sendBtn").onclick = sendMessage;
    byId("stopBtn").onclick = function () {
      endUndoGroup();
      if (activeStreamRequest) {
        activeStreamRequest.abort();
        activeStreamRequest = null;
      }
      setBusy(false);
    };

    byId("inputText").onkeydown = function (e) {
      e = e || window.event;
      if (e.keyCode === 13 && !e.shiftKey) {
        if (e.preventDefault) {
          e.preventDefault();
        }
        sendMessage();
        autoExpand();
      }
    };

    registerSelectionListener();
    renderTray();
    pollHealth();
    setInterval(pollHealth, 5000);
    fetchUpdaterStatus(true);
  }

  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    init();
  } else {
    document.addEventListener
      ? document.addEventListener("DOMContentLoaded", init)
      : (window.onload = init);
  }

  // ---------------------------------------------------------------
  // Accounts logic
  // ---------------------------------------------------------------

  var accountDropdown = byId("accountDropdown");
  var accountBtn = byId("accountBtn");
  var isDropdownOpen = false;

  accountBtn.onclick = function (e) {
    e.stopPropagation();
    isDropdownOpen = !isDropdownOpen;
    accountDropdown.style.display = isDropdownOpen ? "flex" : "none";
    if (isDropdownOpen) {
      loadAccounts();
    }
  };

  document.onclick = function () {
    isDropdownOpen = false;
    accountDropdown.style.display = "none";
  };

  function loadAccounts() {
    getJSON(
      "/auth/status",
      function (res) {
        accountDropdown.innerHTML = "";
        if (!res.accounts || res.accounts.length === 0) {
          var empty = el("div", "account-item");
          empty.textContent = "Нет аккаунтов";
          accountDropdown.appendChild(empty);
        } else {
          res.accounts.forEach(function (acc) {
            var item = el("div", "account-item");
            if (acc.id === res.current_index) {
              item.className += " active";
            }

            var textSpan = el("span", "account-item-text", acc.name);
            textSpan.onclick = function (e) {
              e.stopPropagation();
              switchAccount(acc.id);
            };

            var actions = el("div", "account-actions");

            var editBtn = el("button", "account-edit-btn");
            editBtn.title = "Переименовать";
            editBtn.innerHTML =
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
            editBtn.onclick = function (e) {
              e.stopPropagation();
              customPrompt(
                "Переименовать аккаунт:",
                acc.name,
                function (newName) {
                  if (newName && newName.trim()) {
                    postJSON(
                      "/auth/rename",
                      { index: acc.id, name: newName.trim() },
                      function () {
                        loadAccounts();
                      },
                    );
                  }
                },
              );
            };

            var rmBtn = el("button", "account-remove-btn");
            rmBtn.title = "Выйти из аккаунта";
            rmBtn.innerHTML =
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
            rmBtn.onclick = function (e) {
              e.stopPropagation();
              logoutAccount(acc.id);
            };

            actions.appendChild(editBtn);
            actions.appendChild(rmBtn);

            item.appendChild(textSpan);
            item.appendChild(actions);
            accountDropdown.appendChild(item);
          });
        }

        var addBtn = el("div", "account-item action");
        addBtn.textContent = "+ Добавить аккаунт";
        addBtn.onclick = function (e) {
          e.stopPropagation();
          loginAccount();
        };
        accountDropdown.appendChild(addBtn);

        if (!res.is_authenticated) {
          accountBtn.textContent = "Войти";
          accountBtn.style.color = "#F44336";
        } else {
          var curr = null;
          for (var i = 0; i < res.accounts.length; i++) {
            if (res.accounts[i].id === res.current_index) {
              curr = res.accounts[i];
              break;
            }
          }
          accountBtn.textContent = curr ? curr.name : "Аккаунты";
          accountBtn.style.color = "#ddd";
        }
      },
      function (err) {
        console.error("Failed to load accounts", err);
      },
    );
  }

  function loginAccount() {
    customAlert("Opening browser for OAuth login. Please authenticate...");
    postJSON("/auth/login", {}, function (res) {
      var polls = 0;
      var interval = setInterval(function () {
        loadAccounts();
        polls++;
        if (polls > 30) clearInterval(interval); // Poll for 90s instead of 30s
      }, 3000);
    });
  }

  function switchAccount(idx) {
    postJSON("/auth/switch", { index: idx }, function () {
      loadAccounts();
    });
  }

  function logoutAccount(idx) {
    customConfirm(
      "Вы уверены, что хотите выйти из этого аккаунта?",
      function () {
        postJSON("/auth/logout", { index: idx }, function () {
          loadAccounts();
        });
      },
    );
  }

  // ---------------------------------------------------------------
  // Chat Sidebar Logic
  // ---------------------------------------------------------------

  var sidebar = byId("sidebar");
  var sidebarOverlay = byId("sidebarOverlay");
  var toggleSidebarBtn = byId("toggleSidebarBtn");
  var closeSidebarBtn = byId("closeSidebarBtn");
  var newChatBtn = byId("newChatBtn");
  var chatList = byId("chatList");

  function openSidebar() {
    sidebarOverlay.style.display = "block";
    // tiny delay for transition
    setTimeout(function () {
      sidebarOverlay.style.opacity = "1";
      sidebar.style.transform = "translateX(0)";
    }, 10);
  }

  function closeSidebar() {
    sidebarOverlay.style.opacity = "0";
    sidebar.style.transform = "translateX(-100%)";
    setTimeout(function () {
      sidebarOverlay.style.display = "none";
    }, 300);
  }

  toggleSidebarBtn.onclick = openSidebar;
  closeSidebarBtn.onclick = closeSidebar;
  sidebarOverlay.onclick = closeSidebar;

  var sidebarNewChatBtn = byId("sidebarNewChatBtn");

  function createNewChat() {
    postJSON("/chats/new", {}, function (res) {
      loadChats();
      loadHistory();
      closeSidebar();
    });
  }

  newChatBtn.onclick = createNewChat;
  if (sidebarNewChatBtn) {
    sidebarNewChatBtn.onclick = createNewChat;
  }

  var currentChatId = "default";

  function loadChats() {
    getJSON("/chats", function (res) {
      if (res.current_id) {
        currentChatId = res.current_id;
      }
      chatList.innerHTML = "";
      if (res.chats) {
        res.chats.forEach(function (chat) {
          var item = el("div", "chat-item");
          if (chat.id === res.current_id) {
            item.className += " active";
          }

          var title = el("div", "chat-item-title");
          title.textContent = chat.title || "Новый чат";
          title.title = chat.title;

          var actions = el("div", "chat-item-actions");

          var edit = el("div", "chat-item-edit");
          edit.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
          edit.title = "Переименовать";
          edit.onclick = function (e) {
            e.stopPropagation();

            var input = el("input", "chat-item-input");
            input.type = "text";
            input.value = chat.title || "";

            title.innerHTML = "";
            title.appendChild(input);
            actions.style.display = "none";

            input.focus();
            if (input.select) input.select();

            var saved = false;
            function saveRename() {
              if (saved) return;
              saved = true;
              var newTitle = input.value.trim();
              if (newTitle && newTitle !== chat.title) {
                postJSON(
                  "/chats/rename",
                  { id: chat.id, title: newTitle },
                  function () {
                    loadChats();
                  },
                );
              } else {
                loadChats();
              }
            }

            input.onkeydown = function (ev) {
              ev = ev || window.event;
              if (ev.keyCode === 13) {
                saveRename();
              } else if (ev.keyCode === 27) {
                saved = true;
                loadChats();
              }
            };

            input.onblur = saveRename;
            input.onclick = function (ev) {
              ev.stopPropagation();
            };
            input.onmousedown = function (ev) {
              ev.stopPropagation();
            };
          };

          var del = el("div", "chat-item-delete");
          del.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
          del.title = "Удалить чат";
          del.onclick = function (e) {
            e.stopPropagation();
            customConfirm("Удалить чат?", function () {
              postJSON("/chats/delete", { id: chat.id }, function () {
                loadChats();
                if (chat.id === res.current_id) {
                  loadHistory();
                }
              });
            });
          };

          actions.appendChild(edit);
          actions.appendChild(del);

          item.onclick = function () {
            if (chat.id !== res.current_id) {
              postJSON("/chats/switch", { id: chat.id }, function () {
                loadChats();
                loadHistory();
                closeSidebar();
              });
            } else {
              closeSidebar();
            }
          };

          item.appendChild(title);
          item.appendChild(actions);
          chatList.appendChild(item);
        });
      }
    });
  }

  function loadHistory() {
    getJSON("/chats/history", function (res) {
      var inner = byId("messagesInner");
      if (inner) {
        inner.innerHTML = "";
        inner.style.paddingBottom = "0px";
      }
      activeUserMsgTop = null;
      if (res.messages && res.messages.length > 0) {
        res.messages.forEach(function (m) {
          if (m.role === "user") {
            if (
              m.content &&
              typeof m.content === "string" &&
              m.content.trim() !== ""
            ) {
              addMessage("user", m.content);
            }
            if (m.attachments && m.attachments.length > 0) {
              m.attachments.forEach(function (a) {
                addAttachmentBubble(a);
              });
            }
          } else if (m.role === "assistant") {
            if (
              m.thought &&
              typeof m.thought === "string" &&
              m.thought.trim() !== ""
            ) {
              addReasoning(m.thought);
            }
            if (
              m.content &&
              typeof m.content === "string" &&
              m.content.trim() !== ""
            ) {
              addMessage("agent", m.content);
            }
            if (m.tool_calls) {
              m.tool_calls.forEach(function (tc) {
                var block = createToolBlock(tc.name, tc.arguments);
                // Check if the next message is a tool response for this tool call
                var hasResult = false;
                res.messages.forEach(function (tm) {
                  if (tm.role === "tool" && tm.tool_call_id === tc.id) {
                    block.setResult(tm.content, false); // Best effort, don't know if error
                    hasResult = true;
                  }
                });
                if (!hasResult) {
                  // Still waiting or failed
                  block.setResult("...", false);
                }
              });
            }
          }
        });
        scrollToBottom();
      } else {
        // Render splash
        byId("messagesInner").innerHTML =
          '<div id="splashScreen">' +
          '<div class="splash-icon">' +
          '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#4da6ff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"></circle>' +
          '<path d="M12 16v-4"></path>' +
          '<path d="M12 8h.01"></path>' +
          "</svg>" +
          "</div>" +
          '<div class="splash-title">AI Assistant for CorelDRAW</div>' +
          '<div class="splash-subtitle">Выберите объект в документе или попросите сгенерировать дизайн</div>' +
          '<div class="prompt-suggestions">' +
          '<button class="prompt-chip" data-prompt="Создай красный круг размером 50х50 мм по центру">Красный круг 50x50 мм</button>' +
          '<button class="prompt-chip" data-prompt="Нарисуй синий прямоугольник 100х60 мм">Синий прямоугольник</button>' +
          '<button class="prompt-chip" data-prompt="Создай золотую пятиконечную звезду">Золотая звезда</button>' +
          "</div>" +
          "</div>";

        // Bind prompt chips
        var chips = document.querySelectorAll(".prompt-chip");
        if (chips) {
          var cIdx;
          for (cIdx = 0; cIdx < chips.length; cIdx += 1) {
            (function (chip) {
              chip.onclick = function () {
                var promptText = chip.getAttribute("data-prompt");
                if (promptText) {
                  byId("inputText").value = promptText;
                  autoExpand();
                  sendMessage();
                }
              };
            })(chips[cIdx]);
          }
        }
      }
    });
  }

  loadChats();
  loadHistory();

  // Refresh auth status on load
  setTimeout(loadAccounts, 500);

  // ---------------------------------------------------------------
  // Custom Modals & Settings
  // ---------------------------------------------------------------

  function setupDialogPolyfill(dialog) {
    if (!dialog) return;
    if (!dialog.showModal) {
      dialog.showModal = function () {
        dialog.style.display = "block";
        dialog.style.position = "fixed";
        dialog.style.top = "50%";
        dialog.style.left = "50%";
        if (dialog.style.msTransform !== undefined) {
          dialog.style.msTransform = "translate(-50%, -50%)";
        }
        dialog.style.transform = "translate(-50%, -50%)";
        dialog.style.zIndex = "10001";
        dialog.style.margin = "0";

        if (!window._dialogBackdrop) {
          var bg = document.createElement("div");
          bg.style.position = "fixed";
          bg.style.top = "0";
          bg.style.left = "0";
          bg.style.right = "0";
          bg.style.bottom = "0";
          bg.style.background = "rgba(0,0,0,0.6)";
          bg.style.zIndex = "10000";
          document.body.appendChild(bg);
          window._dialogBackdrop = bg;
        }
        window._dialogBackdrop.style.display = "block";
      };
    }
    if (!dialog.close) {
      dialog.close = function () {
        dialog.style.display = "none";
        if (window._dialogBackdrop) {
          window._dialogBackdrop.style.display = "none";
        }
      };
    }
  }

  function showCustomModal(options) {
    var dialog = byId("customModal");
    setupDialogPolyfill(dialog);

    var title = byId("customModalTitle");
    var body = byId("customModalBody");
    var inputContainer = byId("customModalInputContainer");
    var input = byId("customModalInput");
    var cancelBtn = byId("customModalCancel");
    var okBtn = byId("customModalOk");

    title.textContent = options.title || "Уведомление";
    body.textContent = options.body || "";

    if (options.type === "prompt") {
      inputContainer.style.display = "block";
      input.value = options.defaultValue || "";
    } else {
      inputContainer.style.display = "none";
    }

    if (options.type === "alert") {
      cancelBtn.style.display = "none";
    } else {
      cancelBtn.style.display = "inline-block";
    }

    cancelBtn.onclick = function () {
      dialog.close();
      if (options.onCancel) options.onCancel();
    };

    okBtn.onclick = function () {
      dialog.close();
      if (options.onOk) {
        if (options.type === "prompt") {
          options.onOk(input.value);
        } else {
          options.onOk();
        }
      }
    };

    dialog.showModal();
    if (options.type === "prompt") {
      input.focus();
    }
  }

  function customAlert(msg) {
    showCustomModal({ type: "alert", body: msg });
  }

  function customConfirm(msg, onOk) {
    showCustomModal({ type: "confirm", body: msg, onOk: onOk });
  }

  function customPrompt(msg, defaultValue, onOk) {
    showCustomModal({
      type: "prompt",
      body: msg,
      defaultValue: defaultValue,
      onOk: onOk,
    });
  }

  function loadModels() {
    var current = byId("modelSelectCurrent");
    var list = byId("modelSelectList");
    if (!current || !list) return;

    getJSON("/settings/model", function (res) {
      if (res.available_models) {
        list.innerHTML = "";
        var currentDisplayName = res.current_model;
        var foundCurrent = false;

        // Render header
        var header = el("div", "model-dropdown-header");
        var headerText = el("span", "", "Models");
        var resetBtn = el("button", "model-reset-btn");
        resetBtn.title = "Сбросить и обновить";
        resetBtn.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="-960 960 960 960" fill="currentColor"><path d="M480-160q-134 0-227-93t-93-227q0-134 93-227t227-93q69 0 132 28.5T720-690v-110h80v280H520v-80h168q-32-56-87.5-88T480-720q-100 0-170 70t-70 170q0 100 70 170t170 70q77 0 139-44t87-116h84q-28 106-114 173t-196 67Z"/></svg>';
        resetBtn.onclick = function (e) {
          e = e || window.event;
          if (e.stopPropagation) e.stopPropagation();
          postJSON("/settings/model/reset", {}, function () {
            loadModels();
          });
        };
        header.appendChild(headerText);
        header.appendChild(resetBtn);
        list.appendChild(header);

        res.available_models.forEach(function (m) {
          if (m.id === res.current_model) {
            currentDisplayName = m.display_name;
            foundCurrent = true;
          }

          var li = el("li", "model-dropdown-item");

          var textSpan = el("span", "model-dropdown-item-text", m.display_name);

          // Click anywhere on the li (item) to select model
          li.onclick = function (e) {
            e = e || window.event;
            var target = e.target || e.srcElement;

            // If user clicked delete button, do not switch model
            if (
              target &&
              (target === delBtn ||
                (target.className &&
                  String(target.className).indexOf("model-delete-btn") > -1))
            ) {
              return;
            }

            if (e.stopPropagation) e.stopPropagation();
            if (e.cancelBubble !== undefined) e.cancelBubble = true;

            list.className = list.className.replace(" show", "");
            current.innerHTML = "";
            current.appendChild(document.createTextNode(m.display_name));

            postJSON("/settings/model", { model: m.id }, function () {
              loadModels();
            });
          };

          // In-place replacement with API model name after 1.2s hover (IE11 compatible)
          if (m.display_name && m.display_name !== m.id) {
            (function (targetSpan, originalName, apiName) {
              var hoverTimer = null;
              li.onmouseover = function () {
                if (hoverTimer) clearTimeout(hoverTimer);
                hoverTimer = setTimeout(function () {
                  targetSpan.innerHTML = "";
                  targetSpan.appendChild(document.createTextNode(apiName));
                }, 500);
              };
              li.onmouseout = function () {
                if (hoverTimer) {
                  clearTimeout(hoverTimer);
                  hoverTimer = null;
                }
                targetSpan.innerHTML = "";
                targetSpan.appendChild(document.createTextNode(originalName));
              };
            })(textSpan, m.display_name, m.id);
          }

          var quotaSpan = null;
          if (m.quota_pct !== null && m.quota_pct !== undefined) {
            quotaSpan = el("span", "model-quota", m.quota_pct + "%");
          }

          var delBtn = el("button", "model-delete-btn");
          delBtn.title = "Удалить";
          delBtn.innerHTML =
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
          delBtn.onclick = function (e) {
            e = e || window.event;
            if (e.stopPropagation) e.stopPropagation();
            if (e.preventDefault) e.preventDefault();
            var xhr = new XMLHttpRequest();
            xhr.open("DELETE", "/settings/model");
            xhr.setRequestHeader("Content-Type", "application/json");
            xhr.onreadystatechange = function () {
              if (xhr.readyState === 4 && xhr.status === 200) {
                loadModels();
              }
            };
            xhr.send(JSON.stringify({ model: m.id }));
          };

          li.appendChild(textSpan);
          if (quotaSpan) {
            li.appendChild(quotaSpan);
          }
          li.appendChild(delBtn);
          list.appendChild(li);
        });

        if (!foundCurrent && res.available_models.length > 0) {
          currentDisplayName = res.available_models[0].display_name;
        }

        current.innerHTML = "";
        current.appendChild(document.createTextNode(currentDisplayName));
      }
    });
  }

  var modelSelectCurrent = byId("modelSelectCurrent");
  var modelSelectList = byId("modelSelectList");
  if (modelSelectCurrent && modelSelectList) {
    modelSelectCurrent.onclick = function () {
      if (modelSelectList.className.indexOf("show") > -1) {
        modelSelectList.className = modelSelectList.className.replace(
          " show",
          "",
        );
      } else {
        modelSelectList.className += " show";
      }
    };

    document.addEventListener("click", function (e) {
      e = e || window.event;
      var target = e.target || e.srcElement;
      if (!target) return;

      if (target.nodeType === 3) {
        target = target.parentNode;
      }

      var wrapper = byId("modelSelectWrapper");
      if (!wrapper) return;

      var isInside = false;
      try {
        if (wrapper.contains && typeof wrapper.contains === "function") {
          isInside = wrapper.contains(target);
        } else {
          var curr = target;
          while (curr) {
            if (curr === wrapper) {
              isInside = true;
              break;
            }
            curr = curr.parentNode;
          }
        }
      } catch (err) {
        var node = target;
        while (node) {
          if (node === wrapper) {
            isInside = true;
            break;
          }
          node = node.parentNode;
        }
      }

      if (!isInside) {
        modelSelectList.className = modelSelectList.className.replace(
          " show",
          "",
        );
      }
    });
  }

  loadModels();

  // ---------------------------------------------------------------
  // Auto-Updater Logic
  // ---------------------------------------------------------------

  var updaterModal = byId("updaterModal");
  var updateModalBtn = byId("updateModalBtn");
  var closeUpdaterModalBtn = byId("closeUpdaterModalBtn");
  var checkUpdateBtn = byId("checkUpdateBtn");
  var testUpdateBtn = byId("testUpdateBtn");
  var applyUpdateBtn = byId("applyUpdateBtn");
  var rollbackBtn = byId("rollbackBtn");
  var autoCheckCheckbox = byId("autoCheckCheckbox");
  var updateBanner = byId("updateBanner");
  var updateBannerBtn = byId("updateBannerBtn");
  var updateBannerClose = byId("updateBannerClose");
  var versionLabel = byId("versionLabel");
  var currentVersionVal = byId("currentVersionVal");
  var updateBadge = byId("updateBadge");
  var updateStatusText = byId("updateStatusText");
  var updateDetailsBox = byId("updateDetailsBox");
  var latestVersionVal = byId("latestVersionVal");
  var releaseNotesText = byId("releaseNotesText");

  function openUpdaterModal() {
    if (updaterModal) {
      setupDialogPolyfill(updaterModal);
      updaterModal.showModal();
      fetchUpdaterStatus(false);
    }
  }

  function closeUpdaterModal() {
    if (updaterModal) {
      setupDialogPolyfill(updaterModal);
      updaterModal.close();
    }
  }

  if (updateModalBtn) updateModalBtn.onclick = openUpdaterModal;
  if (closeUpdaterModalBtn) closeUpdaterModalBtn.onclick = closeUpdaterModal;
  if (updateBannerBtn) updateBannerBtn.onclick = openUpdaterModal;
  if (updateBannerClose) {
    updateBannerClose.onclick = function () {
      if (updateBanner) updateBanner.style.display = "none";
    };
  }

  function compareSemver(v1, v2) {
    var p1 = (v1 || "").replace(/^v/, "").split(".");
    var p2 = (v2 || "").replace(/^v/, "").split(".");
    var len = Math.max(p1.length, p2.length);
    for (var i = 0; i < len; i += 1) {
      var n1 = parseInt(p1[i] || 0, 10);
      var n2 = parseInt(p2[i] || 0, 10);
      if (n1 > n2) return 1;
      if (n1 < n2) return -1;
    }
    return 0;
  }

  function updateUpdaterUI(info, showNoticeIfNoUpdate) {
    if (!info) return;

    if (versionLabel) versionLabel.innerText = "v" + info.version;
    if (currentVersionVal) currentVersionVal.innerText = "v" + info.version;

    if (autoCheckCheckbox) {
      autoCheckCheckbox.checked = !!info.auto_check;
    }

    if (info.last_backup && rollbackBtn) {
      rollbackBtn.style.display = "inline-block";
    }

    var statusRow = byId("statusRow");
    var isNewerAvailable =
      !!info.update_available &&
      compareSemver(info.latest_version, info.version) > 0;

    if (isNewerAvailable) {
      if (updateBadge) updateBadge.style.display = "inline-block";
      if (updateBanner) updateBanner.style.display = "flex";
      if (statusRow) statusRow.style.display = "none";
      if (latestVersionVal)
        latestVersionVal.innerText = "v" + info.latest_version;
      if (releaseNotesText)
        releaseNotesText.innerText =
          info.release_notes || "Улучшения и исправления стабильности.";
      if (updateDetailsBox) updateDetailsBox.style.display = "block";
    } else {
      if (updateBadge) updateBadge.style.display = "none";
      if (updateBanner) updateBanner.style.display = "none";
      if (updateDetailsBox) updateDetailsBox.style.display = "none";
      if (statusRow) statusRow.style.display = "flex";

      if (updateStatusText) {
        if (info.last_check_error) {
          updateStatusText.innerText = info.last_check_error;
          updateStatusText.style.color = "#ff6b6b";
        } else {
          updateStatusText.innerText = "У вас установлена актуальная версия";
          updateStatusText.style.color = "#888888";
        }
      }
    }
  }

  function fetchUpdaterStatus(autoCheckIfEnabled) {
    getJSON("/updater/status", function (info) {
      updateUpdaterUI(info, false);
      if (autoCheckIfEnabled && info.auto_check) {
        runCheckForUpdates(false);
      }
    });
  }

  function runCheckForUpdates(manual, mockVersion) {
    if (updateStatusText) {
      updateStatusText.innerText = "Проверка обновлений...";
      updateStatusText.style.color = "#00a8ff";
    }
    postJSON(
      "/updater/check",
      mockVersion ? { mock_version: mockVersion } : {},
      function (info) {
        updateUpdaterUI(info, manual);
      },
      function (err) {
        if (updateStatusText) {
          updateStatusText.innerText =
            "Ошибка проверки: " + (err ? err.message : "Ошибка сети");
          updateStatusText.style.color = "#ff6b6b";
        }
      },
    );
  }

  if (checkUpdateBtn) {
    checkUpdateBtn.onclick = function () {
      runCheckForUpdates(true);
    };
  }

  if (autoCheckCheckbox) {
    autoCheckCheckbox.onchange = function () {
      var isChecked = !!autoCheckCheckbox.checked;
      postJSON(
        "/updater/settings",
        { auto_check: isChecked },
        function (res) {
          if (res && typeof res.auto_check !== "undefined") {
            autoCheckCheckbox.checked = !!res.auto_check;
          }
        },
        function (err) {
          addActionEntry(
            "Ошибка сохранения настроек автообновления: " +
              (err ? err.message : "ошибка сети"),
            true,
          );
        },
      );
    };
  }

  function reloadWhenBackendReady() {
    showCustomModal({
      title: "Перезапуск сервера",
      body: "Ожидание завершения перезапуска сервера. Пожалуйста, подождите...",
    });
    var okBtn = byId("customModalOk");
    if (okBtn) {
      okBtn.disabled = true;
      okBtn.innerText = "Подключение...";
    }
    function checkHealth() {
      getJSON(
        "/health",
        function (res) {
          if (res && res.ok) {
            window.location.reload();
          } else {
            setTimeout(checkHealth, 1000);
          }
        },
        function () {
          setTimeout(checkHealth, 1000);
        },
      );
    }
    setTimeout(checkHealth, 1200);
  }

  if (applyUpdateBtn) {
    applyUpdateBtn.onclick = function () {
      applyUpdateBtn.disabled = true;
      applyUpdateBtn.innerText = "Установка...";
      postJSON(
        "/updater/apply",
        {},
        function (res) {
          applyUpdateBtn.disabled = false;
          applyUpdateBtn.innerText = "Загрузить и установить обновление";
          if (res && res.status === "success") {
            closeUpdaterModal();
            showCustomModal({
              title: "Успешно!",
              body: "Обновление v" + res.version + " успешно установлено.",
              onOk: function () {
                reloadWhenBackendReady();
              },
            });
          } else {
            showCustomModal({
              title: "Ошибка",
              body:
                "Не удалось установить обновление: " +
                (res ? res.message : "неизвестно"),
            });
          }
        },
        function (err) {
          applyUpdateBtn.disabled = false;
          applyUpdateBtn.innerText = "Загрузить и установить обновление";
          showCustomModal({
            title: "Ошибка",
            body:
              "Ошибка установки: " + (err ? err.message : "неизвестная ошибка"),
          });
        },
      );
    };
  }

  if (rollbackBtn) {
    rollbackBtn.onclick = function () {
      showCustomModal({
        title: "Откат версии",
        body: "Вы уверены, что хотите откатить приложение к предыдущей сохраненной версии?",
        onOk: function () {
          postJSON(
            "/updater/rollback",
            {},
            function (res) {
              if (res && res.status === "success") {
                closeUpdaterModal();
                showCustomModal({
                  title: "Успех",
                  body: "Приложение откачено к версии v" + res.version + ".",
                  onOk: function () {
                    reloadWhenBackendReady();
                  },
                });
              } else {
                showCustomModal({
                  title: "Ошибка",
                  body:
                    "Не удалось откатить версию: " +
                    (res ? res.message : "неизвестно"),
                });
              }
            },
            function (err) {
              showCustomModal({
                title: "Ошибка",
                body:
                  "Ошибка при откате: " + (err ? err.message : "ошибка сети"),
              });
            },
          );
        },
      });
    };
  }
})();
