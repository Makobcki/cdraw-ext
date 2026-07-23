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
      overlay.style.pointerEvents = opacity > 0.1 ? "auto" : "none";
    }
  }

  var scrollTimer = null;
  var activeUserMsgTop = null;
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

    if (!smooth) {
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
      }
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

  function postJSON(url, data, onSuccess, onError) {
    var xhr = new XMLHttpRequest();
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.onreadystatechange = function () {
      if (xhr.readyState === 4) {
        if (xhr.status === 200) {
          try {
            var resp = JSON.parse(xhr.responseText);
            if (onSuccess) onSuccess(resp);
          } catch (e) {
            if (onError) onError(e);
          }
        } else {
          if (onError) onError(new Error("HTTP " + xhr.status));
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
              var line = unparsed ? (unparsed + parts[i]) : parts[i];
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
    var sep = url.indexOf('?') === -1 ? '?' : '&';
    var bustUrl = url + sep + '_t=' + new Date().getTime();
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
    throw new Error("CorelDRAW Application API (window.external.Application) недоступен.");
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

  // Gives every shape we touch a stable, unique name so we can find it again
  // in a later turn of the conversation (a live COM reference from
  // shapeRegistry is faster, but may not survive undo/redo or a docker reload,
  // so Name is the durable fallback).
  function ensureShapeName(shape) {
    var name = shape.Name;
    if (!name || name.length === 0) {
      refCounter += 1;
      name = "ai_" + new Date().getTime() + "_" + refCounter;
      shape.Name = name;
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

  function getUnitName(unitCode) {
    var units = {
      1: "inches", 2: "feet", 3: "yards", 4: "miles",
      5: "mm", 6: "cm", 7: "m", 8: "km",
      9: "didots", 10: "agates", 11: "picas", 12: "pt", 13: "px", 14: "ciceros"
    };
    return units[unitCode] || String(unitCode);
  }

  function readShapeProperties(shape) {
    var props = { name: shape.Name, typeCode: shape.Type };
    try {
      var u = activeDoc().Unit;
      props.docUnit = String(u);
      props.docUnitName = getUnitName(u);
    } catch (e) {
      /* ignore */
    }
    try {
      props.width = shape.SizeWidth;
    } catch (e) {
      /* ignore */
    }
    try {
      props.height = shape.SizeHeight;
    } catch (e) {
      /* ignore */
    }
    try {
      props.x = shape.PositionX; // Confirmed CorelDRAW Shape.PositionX property
    } catch (e) {
      /* ignore */
    }
    try {
      props.y = shape.PositionY; // Confirmed CorelDRAW Shape.PositionY property
    } catch (e) {
      /* ignore */
    }
    try {
      var colors = shape.GetColors(); // Confirmed CorelDRAW Shape.GetColors() method
      props.colors = colorsToArray(colors);
    } catch (e) {
      /* ignore */
    }
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
    } catch (e) {
      /* ignore */
    }

    try {
      if (doc) {
        doc.DeselectAll(); // Confirmed CorelDRAW Document.DeselectAll() method
      }
    } catch (e) {
      /* ignore */
    }
    shape.Selected = true; // confirmed pattern from Corel's VBA programming guide

    fn();

    try {
      doc.DeselectAll();
      var j;
      for (j = 0; j < prevNames.length; j += 1) {
        var s = findShapeByRef(prevNames[j]);
        if (s) {
          s.Selected = true;
        }
      }
    } catch (e) {
      /* best effort restore only */
    }
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
      try {
        var shape = requireShape(args.ref);
        if (!shape || !shape.Fill) {
          cb({ error: "Объект не поддерживает заливку (shape.Fill недоступен)." });
          return;
        }
        var fill = shape.Fill;
        var c;
        if (args.cmyk_color) {
          var cmyk = args.cmyk_color;
          c = cdrApp().CreateColorEx(2 /* cdrColorCMYK */, cmyk.c, cmyk.m, cmyk.y, cmyk.k);
        } else if (args.hex_color) {
          var rgb = hexToRgb(args.hex_color);
          c = cdrApp().CreateColorEx(1 /* cdrColorRGB */, rgb.r, rgb.g, rgb.b, 0);
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
      try {
        var shape = requireShape(args.ref);
        if (!shape || !shape.Outline) {
          cb({ error: "Объект не поддерживает обводку (shape.Outline недоступен)." });
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
          var cCmyk = cdrApp().CreateColorEx(2 /* cdrColorCMYK */, cmyk.c, cmyk.m, cmyk.y, cmyk.k);
          outline.Color = cCmyk;
        } else if (args.hex_color) {
          var rgb = hexToRgb(args.hex_color);
          var cRgb = cdrApp().CreateColorEx(1 /* cdrColorRGB */, rgb.r, rgb.g, rgb.b, 0);
          outline.Color = cRgb;
        }
        if (args.style) {
          var styleMap = { solid: 1, dash: 2, dot: 3, dash_dot: 4 };
          var lineStyle = styleMap[args.style];
          if (lineStyle && outline.Style) {
            try { outline.Style = lineStyle; } catch (eStyle) {}
          }
        }
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка настройки обводки: " + e.message });
      }
    },

    flip: function (args, cb) {
      try {
        var shape = requireShape(args.ref);
        if (args.direction === "horizontal") {
          shape.Flip(1 /* cdrFlipHorizontal */);
        } else if (args.direction === "vertical") {
          shape.Flip(2 /* cdrFlipVertical */);
        } else {
          cb({ error: "Неизвестное направление отзеркаливания: " + args.direction });
          return;
        }
        cb({ ok: true, direction: args.direction });
      } catch (e) {
        cb({ error: "Ошибка отзеркаливания объекта: " + e.message });
      }
    },

    set_position: function (args, cb) {
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
        cb({ ok: true, width: args.width, height: args.height, unit: unitName });
      } catch (e) {
        cb({ error: "Ошибка установки размера: " + e.message });
      }
    },

    rotate: function (args, cb) {
      try {
        var shape = requireShape(args.ref);
        shape.Rotate(args.angle);
        cb({ ok: true, angle: args.angle });
      } catch (e) {
        cb({ error: "Ошибка поворота объекта: " + e.message });
      }
    },

    duplicate: function (args, cb) {
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
      try {
        var shape = requireShape(args.ref);
        shape.ConvertToCurves();
        cb({ ok: true });
      } catch (e) {
        cb({ error: "Ошибка преобразования в кривые: " + e.message });
      }
    },

    order: function (args, cb) {
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
            cb({ error: "Для режима " + mode + " требуется параметр target_ref." });
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
      try {
        var shape = requireShape(args.ref);
        exportShapeAssets(shape, backendPaths, function () {
          cb({ ok: true, svg_path: backendPaths.svg_path });
        });
      } catch (e) {
        cb({ error: "Ошибка экспорта SVG: " + e.message });
      }
    },

    import_svg: function (args, cb) {
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
        if (newRef && typeof args.x === "number" && typeof args.y === "number") {
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
        try { newShape.OrderToFrontOf(oldShape); } catch (eOrd) {}
        oldShape.Delete();
        delete shapeRegistry[args.ref];

        cb({ ok: true, new_ref: newRef });
      } catch (e) {
        cb({ error: "Ошибка при замене объекта SVG: " + e.message });
      }
    },

    get_object_info: function (args, cb) {
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
            error: "Выбранный объект не является растровым изображением (битмапом). Код типа объекта: " + (shape ? shape.Type : "undefined") + " (требуется cdrBitmapShape = 4). Пожалуйста, выберите растр для трассировки."
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
          cb({ error: "Объект не содержит растровых данных (shape.Bitmap недоступен)." });
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
        var info = { width: page.SizeWidth, height: page.SizeHeight, unit: unitName, unit_code: unitCode };
        cb(info);
      } catch (e) {
        cb({ error: "Ошибка при получении информации о странице: " + e.message });
      }
    },

    set_text: function (args, cb) {
      try {
        var shape = requireShape(args.ref);
        if (!shape || !shape.Text || !shape.Text.Story) {
          cb({ error: "Объект не содержит текстовых данных (shape.Text.Story недоступен)." });
          return;
        }
        if (typeof args.text === "string") {
          shape.Text.Story.Text = args.text;
        }
        var textStory = shape.Text.Story;
        if (args.font_name && textStory.Font) {
          try { textStory.Font = args.font_name; } catch (eF) {}
        }
        if (typeof args.font_size === "number" && textStory.Size) {
          try { textStory.Size = args.font_size; } catch (eS) {}
        }
        if (args.alignment && textStory.Alignment) {
          var alignMap = { left: 1, center: 2, right: 3, justify: 4 };
          if (alignMap[args.alignment]) {
            try { textStory.Alignment = alignMap[args.alignment]; } catch (eA) {}
          }
        }
        if (args.cmyk_color && textStory.Fill) {
          try {
            var cmyk = args.cmyk_color;
            var cCmyk = cdrApp().CreateColorEx(2 /* cdrColorCMYK */, cmyk.c, cmyk.m, cmyk.y, cmyk.k);
            textStory.Fill.ApplyUniformFill(cCmyk);
          } catch (eCmyk) {}
        } else if (args.hex_color && textStory.Fill) {
          try {
            var rgb = hexToRgb(args.hex_color);
            var cRgb = cdrApp().CreateColorEx(1 /* cdrColorRGB */, rgb.r, rgb.g, rgb.b, 0);
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

  function addMessage(role, text) {
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

  function createToolBlock(name, args) {
    removeSplash();
    var row = el("div", "msg-tool-container");
    var bubble = el("div", "msg-tool-bubble");

    var header = el("div", "msg-tool-header");
    var title = el(
      "div",
      "msg-tool-title",
      name + "(" + JSON.stringify(args) + ")"
    );
    var toggle = el("div", "msg-tool-toggle", "▼");

    header.appendChild(title);
    header.appendChild(toggle);

    var details = el("div", "msg-tool-details");
    details.style.display = "none";

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
        if (isError) {
          bubble.className = "msg-tool-bubble is-error";
          details.style.display = "block";
          header.className = "msg-tool-header open";
        }
        details.textContent = resStr;
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

  function buildAttachCard(a, removable) {
    var card = el("div", "attach-card");
    var thumb = el("div", "thumb");
    thumb.style.backgroundImage =
      "url(/temp_image?path=" + encodeURIComponent(a.png_path) + ")";
    var tag = el("span", "tag", "obj");
    var label = el("div", "label", a.name);
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
    xhr.onload = function() {
      if (xhr.status === 200) {
        try {
          var res = JSON.parse(xhr.responseText);
          staged.push({
            ref: "custom",
            name: res.name,
            properties: { type: file.type || "file", size: file.size },
            png_path: res.png_path,
            svg_path: null
          });
          renderTray();
        } catch (e) {
          addActionEntry("Ошибка разбора ответа: " + e.message, true);
        }
      } else {
        addActionEntry("Ошибка загрузки файла", true);
      }
    };
    xhr.onerror = function() {
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
      customFileInput.onchange = function(e) {
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
    var parts = dataURI.split(',');
    var byteString = atob(parts[1]);
    var mimeString = parts[0].split(':')[1].split(';')[0];
    var ab = new ArrayBuffer(byteString.length);
    var ia = new Uint8Array(ab);
    var i;
    for (i = 0; i < byteString.length; i += 1) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], {type: mimeString});
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

    document.addEventListener("keydown", function(e) {
      if (e.ctrlKey && (e.keyCode === 86 || e.key === "v" || e.key === "V")) {
        var active = document.activeElement;
        
        var start = 0, end = 0, hasSelection = false;
        if (active && typeof active.selectionStart !== "undefined") {
          start = active.selectionStart;
          end = active.selectionEnd;
          hasSelection = true;
        }

        pasteCatcher.focus();

        setTimeout(function() {
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
              active.value = text.substring(0, start) + pastedText + text.substring(end);
              active.selectionStart = active.selectionEnd = start + pastedText.length;
            }
          }
          
          pasteCatcher.innerHTML = "";
          if (active) active.focus();
        }, 50);
      }
    });
  }

  // Handle Ctrl+V paste (Modern browsers)
  document.addEventListener("paste", function(e) {
    if (isIE11) return; // Handled by keydown hack above

    var clipboardData = e.clipboardData || window.clipboardData;
    if (!clipboardData) return;
    
    var i, file;
    if (clipboardData.items) {
      for (i = 0; i < clipboardData.items.length; i += 1) {
        if (clipboardData.items[i].kind === 'file') {
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
    var sel;
    try {
      sel = cdrApp().ActiveSelectionRange;
    } catch (e) {
      // If we cannot connect to CorelDRAW, we can also fallback to custom file
      triggerCustomFileUpload();
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
        getJSON(
          "/export_paths",
          function (paths) {
            exportShapeAssets(shape, paths, function () {
              staged.push({
                ref: ref,
                name: shape.Name,
                properties: props,
                png_path: paths.png_path,
                svg_path: paths.svg_path,
              });
              renderTray();
            });
          },
          function (err) {
            addActionEntry("Ошибка экспорта: " + err.message, true);
          }
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
        "onSelectionChange()"
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
          "onSelectionChange()"
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

    postJSONStream(
      url,
      data,
      function (chunk) {
        setBusy(false);

        if (chunk.type === "chunk") {
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
      }
    );
  }

  function sendMessage() {
    var input = byId("inputText");
    var text = input.value;
    if (!text && staged.length === 0) {
      return;
    }
    if (busy) {
      return;
    }

    var userBubble = null;
    if (text) {
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
      streamBackendResponse("/chat", { message: text, attachments: currentStaged });
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
        { tool_call_id: call.id, result: result },
        function () {
          runToolCallsSequentially(calls, index + 1, onAllDone);
        }
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
        }
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
        }
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
      }
    );
  }

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------

  function init() {
    byId("attachBtn").onclick = attachCurrentSelection;
    byId("sendBtn").onclick = sendMessage;
    byId("stopBtn").onclick = function () {
      endUndoGroup();
      // Hard refresh to interrupt backend streaming
      location.reload();
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
                      }
                    );
                  }
                }
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
      }
    );
  }

  function loginAccount() {
    postJSON("/auth/login", {}, function (res) {
      var polls = 0;
      var interval = setInterval(function () {
        loadAccounts();
        polls++;
        if (polls > 10) clearInterval(interval);
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
      }
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

  function loadChats() {
    getJSON("/chats", function (res) {
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
                  }
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
            if (m.content) {
              addMessage("user", m.content);
            }
            if (m.attachments && m.attachments.length > 0) {
              m.attachments.forEach(function (a) {
                addAttachmentBubble(a);
              });
            }
          } else if (m.role === "assistant") {
            if (m.content) {
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
          '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
          '<circle cx="12" cy="12" r="10"></circle>' +
          '<path d="M12 16v-4"></path>' +
          '<path d="M12 8h.01"></path>' +
          "</svg>" +
          '<div class="splash-title">AI Assistant</div>' +
          '<div class="splash-desc">Чем я могу помочь вам сегодня?</div>' +
          "</div>";
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

  function showCustomModal(options) {
    var dialog = byId("customModal");
    if (!dialog.showModal) {
      dialog.showModal = function() {
        dialog.style.display = 'block';
        dialog.style.position = 'fixed';
        dialog.style.top = '50%';
        dialog.style.left = '50%';
        dialog.style.transform = 'translate(-50%, -50%)';
        dialog.style.zIndex = '10001';
        dialog.style.margin = '0';
        if (!window._dialogBackdrop) {
          var bg = document.createElement('div');
          bg.style.position = 'fixed';
          bg.style.top = '0'; bg.style.left = '0'; bg.style.right = '0'; bg.style.bottom = '0';
          bg.style.background = 'rgba(0,0,0,0.6)';
          bg.style.zIndex = '10000';
          document.body.appendChild(bg);
          window._dialogBackdrop = bg;
        }
        window._dialogBackdrop.style.display = 'block';
      };
      dialog.close = function() {
        dialog.style.display = 'none';
        if (window._dialogBackdrop) window._dialogBackdrop.style.display = 'none';
      };
    }
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
          e.stopPropagation();
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
          textSpan.onclick = function (e) {
            e.stopPropagation();
            list.className = list.className.replace(" show", "");
            current.innerText = m.display_name;
            postJSON("/settings/model", { model: m.id }, function () {});
          };

          // In-place replacement with API model name after 1.2s hover (IE11 compatible)
          if (m.display_name && m.display_name !== m.id) {
            (function (targetSpan, originalName, apiName) {
              var hoverTimer = null;
              li.onmouseover = function () {
                if (hoverTimer) clearTimeout(hoverTimer);
                hoverTimer = setTimeout(function () {
                  targetSpan.innerText = apiName;
                }, 1200);
              };
              li.onmouseout = function () {
                if (hoverTimer) {
                  clearTimeout(hoverTimer);
                  hoverTimer = null;
                }
                targetSpan.innerText = originalName;
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
            e.stopPropagation();
            if (e && e.preventDefault) e.preventDefault();
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

        current.innerText = currentDisplayName;
      }
    });
  }

  var modelSelectCurrent = byId("modelSelectCurrent");
  var modelSelectList = byId("modelSelectList");
  if (modelSelectCurrent && modelSelectList) {
    modelSelectCurrent.onclick = function () {
      if (modelSelectList.className.indexOf("show") > -1) {
        modelSelectList.className = modelSelectList.className.replace(" show", "");
      } else {
        modelSelectList.className += " show";
      }
    };

    document.addEventListener("click", function (e) {
      var wrapper = byId("modelSelectWrapper");
      if (wrapper && !wrapper.contains(e.target)) {
        modelSelectList.className = modelSelectList.className.replace(" show", "");
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
      if (updaterModal.showModal) {
        updaterModal.showModal();
      } else {
        updaterModal.style.display = "block";
      }
      fetchUpdaterStatus(false);
    }
  }

  function closeUpdaterModal() {
    if (updaterModal) {
      if (updaterModal.close) {
        updaterModal.close();
      } else {
        updaterModal.style.display = "none";
      }
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
    var isNewerAvailable = !!info.update_available && compareSemver(info.latest_version, info.version) > 0;

    if (isNewerAvailable) {
      if (updateBadge) updateBadge.style.display = "inline-block";
      if (updateBanner) updateBanner.style.display = "flex";
      if (statusRow) statusRow.style.display = "none";
      if (latestVersionVal) latestVersionVal.innerText = "v" + info.latest_version;
      if (releaseNotesText) releaseNotesText.innerText = info.release_notes || "Улучшения и исправления стабильности.";
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
    postJSON("/updater/check", mockVersion ? { mock_version: mockVersion } : {}, function (info) {
      updateUpdaterUI(info, manual);
    }, function (err) {
      if (updateStatusText) {
        updateStatusText.innerText = "Ошибка проверки: " + (err ? err.message : "Ошибка сети");
        updateStatusText.style.color = "#ff6b6b";
      }
    });
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
          addActionEntry("Ошибка сохранения настроек автообновления: " + (err ? err.message : "ошибка сети"), true);
        }
      );
    };
  }

  function reloadWhenBackendReady() {
    showCustomModal("Перезапуск сервера", "Ожидание завершения перезапуска сервера. Пожалуйста, подождите...");
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
        }
      );
    }
    setTimeout(checkHealth, 1200);
  }

  if (applyUpdateBtn) {
    applyUpdateBtn.onclick = function () {
      applyUpdateBtn.disabled = true;
      applyUpdateBtn.innerText = "Установка...";
      postJSON("/updater/apply", {}, function (res) {
        applyUpdateBtn.disabled = false;
        applyUpdateBtn.innerText = "Загрузить и установить обновление";
        if (res && res.status === "success") {
          closeUpdaterModal();
          showCustomModal("Успешно!", "Обновление v" + res.version + " успешно установлено.", function () {
            reloadWhenBackendReady();
          });
        } else {
          showCustomModal("Ошибка", "Не удалось установить обновление: " + (res ? res.message : "неизвестно"));
        }
      }, function (err) {
        applyUpdateBtn.disabled = false;
        applyUpdateBtn.innerText = "Загрузить и установить обновление";
        showCustomModal("Ошибка", "Ошибка установки: " + (err ? err.message : "неизвестная ошибка"));
      });
    };
  }

  if (rollbackBtn) {
    rollbackBtn.onclick = function () {
      showCustomModal("Откат версии", "Вы уверены, что хотите откатить приложение к предыдущей сохраненной версии?", function () {
        postJSON("/updater/rollback", {}, function (res) {
          if (res && res.status === "success") {
            closeUpdaterModal();
            showCustomModal("Успех", "Приложение откачено к версии v" + res.version + ".", function () {
              reloadWhenBackendReady();
            });
          } else {
            showCustomModal("Ошибка", "Не удалось откатить версию: " + (res ? res.message : "неизвестно"));
          }
        }, function (err) {
          showCustomModal("Ошибка", "Ошибка при откате: " + (err ? err.message : "ошибка сети"));
        });
      });
    };
  }
})();
