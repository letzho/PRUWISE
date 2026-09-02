/* ==========================================================================
   charts.js
   --------------------------------------------------------------------------
   Hand-built SVG charts. No chart library needed.

   WHY THEY RESIZE PERFECTLY
   Every chart is drawn inside a fixed "viewBox", for example 0 0 760 220.
   That is the chart's own private coordinate system. The CSS in
   components.css then says:

       .chart svg { width: 100%; height: auto; }

   So the browser scales the whole drawing to fit whatever space it is given -
   a 320px phone or a 1440px monitor - with no JavaScript resize listeners.
   Text, lines and bars all scale together.

   Each function returns a STRING of HTML, the same as ui.js.
   ========================================================================== */

var CHARTS = (function () {

    /* Rounds a maximum value up to a "nice" number so the axis labels read
       cleanly: 47 becomes 50, 1234 becomes 2000, and so on. */
    function niceMax(value) {
        if (value <= 0) { return 10; }
        var magnitude = Math.pow(10, Math.floor(Math.log10(value)));
        var scaled = value / magnitude;
        var step = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10;
        return step * magnitude;
    }

    /* Picks which x-axis labels to show. On a narrow chart, drawing all 12
       month names would overlap, so we show at most `maxTicks` of them. */
    function pickTicks(count, maxTicks) {
        var out = [];
        if (count <= maxTicks) {
            for (var i = 0; i < count; i++) { out.push(i); }
            return out;
        }
        var stride = Math.ceil(count / maxTicks);
        for (var j = 0; j < count; j += stride) { out.push(j); }
        if (out[out.length - 1] !== count - 1) { out.push(count - 1); }
        return out;
    }

    // Gives each gradient a unique id, so two charts on one page never clash
    var uid = 0;
    function nextId(prefix) {
        uid = uid + 1;
        return prefix + '-' + uid;
    }

    // Colour key underneath a chart
    function legend(series) {
        return '<div class="legend">' + series.map(function (s) {
            return '<span class="legend-item"><span class="swatch" style="background:' + s.color + '"></span>' +
                FMT.esc(s.name) + '</span>';
        }).join('') + '</div>';
    }


    /* ======================================================================
       SPARKLINE
       The tiny trend line inside a KPI card. No axes, no labels.
       ====================================================================== */
    function sparkline(values, color) {
        if (!values || values.length < 2) { return ''; }

        var W = 120;
        var H = 30;
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        var range = (max - min) || 1;
        var stroke = color || 'var(--c1)';
        var gradId = nextId('spark');

        // Turn each value into an x,y point inside our 120x30 box
        var points = values.map(function (v, i) {
            var x = (i / (values.length - 1)) * (W - 4) + 2;
            var y = H - 3 - ((v - min) / range) * (H - 8);
            return [x, y];
        });

        // "M" = move to, "L" = line to. This is standard SVG path syntax.
        var line = points.map(function (p, i) {
            return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
        }).join(' ');

        // Close the shape down to the bottom edge so we can fill under it
        var area = line + ' L' + points[points.length - 1][0].toFixed(1) + ' ' + H +
            ' L' + points[0][0].toFixed(1) + ' ' + H + ' Z';

        return '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
            'style="height:30px" aria-hidden="true">' +
            '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' + stroke + '" stop-opacity="0.28"/>' +
            '<stop offset="100%" stop-color="' + stroke + '" stop-opacity="0"/>' +
            '</linearGradient></defs>' +
            '<path d="' + area + '" fill="url(#' + gradId + ')"/>' +
            '<path d="' + line + '" fill="none" stroke="' + stroke + '" stroke-width="2" ' +
            'stroke-linecap="round" stroke-linejoin="round"/>' +
            '</svg></div>';
    }


    /* ======================================================================
       LINE CHART
       line({ labels:['Feb','Mar'], series:[{name, color, values:[1,2]}] })
       ====================================================================== */
    function line(o) {
        o = o || {};
        var labels = o.labels || [];
        var series = o.series || [];
        if (!labels.length || !series.length) { return ''; }

        var format = o.format || FMT.num;
        var W = 760;
        var H = o.height || 220;
        var padL = 54, padR = 14, padT = 14, padB = 30;   // room for the labels
        var innerW = W - padL - padR;
        var innerH = H - padT - padB;

        // Find the biggest value across every series
        var allValues = [];
        series.forEach(function (s) { allValues = allValues.concat(s.values); });
        var max = niceMax(Math.max.apply(null, allValues.concat([1])));

        var xFor = function (i) {
            return labels.length === 1 ? padL + innerW / 2 : padL + (i / (labels.length - 1)) * innerW;
        };
        var yFor = function (v) {
            return padT + innerH - (v / max) * innerH;
        };

        var svg = '';

        // Horizontal grid lines + the value labels down the left
        var ticks = o.yTicks || 4;
        for (var t = 0; t <= ticks; t++) {
            var value = (max / ticks) * t;
            var y = yFor(value);
            svg += '<line class="chart-grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
            svg += '<text class="chart-axis" x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' +
                FMT.esc(format(value)) + '</text>';
        }

        // Month names along the bottom
        pickTicks(labels.length, 7).forEach(function (i) {
            svg += '<text class="chart-axis" x="' + xFor(i) + '" y="' + (H - 10) + '" text-anchor="middle">' +
                FMT.esc(labels[i]) + '</text>';
        });

        // One line (plus a soft fill underneath) per series
        series.forEach(function (s, sIndex) {
            var points = s.values.map(function (v, i) { return [xFor(i), yFor(v)]; });
            var path = points.map(function (p, i) {
                return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ' ' + p[1].toFixed(1);
            }).join(' ');

            if (o.area !== false) {
                var gradId = nextId('area');
                svg += '<defs><linearGradient id="' + gradId + '" x1="0" y1="0" x2="0" y2="1">' +
                    '<stop offset="0%" stop-color="' + s.color + '" stop-opacity="' + (sIndex === 0 ? '0.24' : '0.12') + '"/>' +
                    '<stop offset="100%" stop-color="' + s.color + '" stop-opacity="0"/>' +
                    '</linearGradient></defs>';
                svg += '<path d="' + path + ' L' + points[points.length - 1][0].toFixed(1) + ' ' + (padT + innerH) +
                    ' L' + points[0][0].toFixed(1) + ' ' + (padT + innerH) + ' Z" fill="url(#' + gradId + ')"/>';
            }

            svg += '<path d="' + path + '" fill="none" stroke="' + s.color + '" stroke-width="2.5" ' +
                'stroke-linecap="round" stroke-linejoin="round"/>';

            // A dot on each data point. The <title> gives a free tooltip on hover.
            points.forEach(function (p, i) {
                svg += '<circle class="chart-dot" cx="' + p[0] + '" cy="' + p[1] + '" r="3.6" ' +
                    'fill="var(--surface)" stroke="' + s.color + '" stroke-width="2.2">' +
                    '<title>' + FMT.esc(s.name + ' - ' + labels[i] + ': ' + format(s.values[i])) + '</title></circle>';
            });
        });

        return '<div class="stack-2"><div class="chart">' +
            '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Line chart">' + svg + '</svg>' +
            '</div>' + (o.legend === false ? '' : legend(series)) + '</div>';
    }


    /* ======================================================================
       BAR CHART
       Same inputs as the line chart. Handles one or more series side by side.
       ====================================================================== */
    function bars(o) {
        o = o || {};
        var labels = o.labels || [];
        var series = o.series || [];
        if (!labels.length || !series.length) { return ''; }

        var format = o.format || FMT.num;
        var W = 760;
        var H = o.height || 220;
        var padL = 54, padR = 14, padT = 14, padB = 30;
        var innerW = W - padL - padR;
        var innerH = H - padT - padB;

        var allValues = [];
        series.forEach(function (s) { allValues = allValues.concat(s.values); });
        var max = niceMax(Math.max.apply(null, allValues.concat([1])));

        var groupW = innerW / labels.length;
        var barW = Math.min(28, (groupW * 0.62) / series.length);
        var yFor = function (v) { return padT + innerH - (v / max) * innerH; };

        var svg = '';
        var ticks = o.yTicks || 4;
        for (var t = 0; t <= ticks; t++) {
            var value = (max / ticks) * t;
            var y = yFor(value);
            svg += '<line class="chart-grid-line" x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '"/>';
            svg += '<text class="chart-axis" x="' + (padL - 8) + '" y="' + (y + 3.5) + '" text-anchor="end">' +
                FMT.esc(format(value)) + '</text>';
        }

        labels.forEach(function (label, i) {
            var centre = padL + groupW * i + groupW / 2;
            svg += '<text class="chart-axis" x="' + centre + '" y="' + (H - 10) + '" text-anchor="middle">' +
                FMT.esc(label) + '</text>';

            series.forEach(function (s, sIndex) {
                var v = s.values[i] || 0;
                var barH = Math.max(2, (v / max) * innerH);
                var x = centre - (barW * series.length) / 2 + sIndex * barW;
                svg += '<rect class="chart-bar" x="' + (x + 1) + '" y="' + yFor(v) + '" ' +
                    'width="' + Math.max(4, barW - 2) + '" height="' + barH + '" rx="4" fill="' + s.color + '">' +
                    '<title>' + FMT.esc(s.name + ' - ' + label + ': ' + format(v)) + '</title></rect>';
            });
        });

        return '<div class="stack-2"><div class="chart">' +
            '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Bar chart">' + svg + '</svg>' +
            '</div>' + (o.legend === false ? '' : legend(series)) + '</div>';
    }


    /* ======================================================================
       DONUT CHART
       donut({ items:[{label, value, color}], centerValue, centerLabel })

       HOW THE RING IS DRAWN (the one genuinely clever bit)
       Each slice is a circle with no fill, a thick stroke, and a dashed
       outline where the dash length equals the slice size. We then rotate the
       start point of each slice using stroke-dashoffset so the slices sit
       next to each other instead of on top of each other.
       ====================================================================== */
    function donut(o) {
        o = o || {};
        var items = o.items || [];
        var size = o.size || 190;
        var thickness = o.thickness || 18;

        var total = items.reduce(function (sum, i) { return sum + i.value; }, 0) || 1;
        var radius = (size - thickness) / 2;
        var circumference = 2 * Math.PI * radius;

        // Grey background ring
        var svg = '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius + '" ' +
            'fill="none" stroke="var(--surface-3)" stroke-width="' + thickness + '"/>';

        var offset = 0;
        items.forEach(function (item) {
            var slice = (item.value / total) * circumference;
            svg += '<circle cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius + '" fill="none" ' +
                'stroke="' + item.color + '" stroke-width="' + thickness + '" ' +
                'stroke-dasharray="' + slice + ' ' + (circumference - slice) + '" ' +
                'stroke-dashoffset="' + (-offset) + '" ' +
                // rotate -90 so the first slice starts at the top, not the right
                'transform="rotate(-90 ' + size / 2 + ' ' + size / 2 + ')">' +
                '<title>' + FMT.esc(item.label + ': ' + Math.round((item.value / total) * 100) + '%') + '</title>' +
                '</circle>';
            offset += slice;
        });

        var centre = (o.centerValue !== undefined)
            ? '<div class="donut-center"><div class="donut-value">' + FMT.esc(o.centerValue) + '</div>' +
            (o.centerLabel ? '<div class="donut-label">' + FMT.esc(o.centerLabel) + '</div>' : '') + '</div>'
            : '';

        var list = (o.legend === false) ? '' :
            '<div class="stack-2">' + items.map(function (item) {
                return '<div class="between">' +
                    '<span class="legend-item"><span class="swatch" style="background:' + item.color + '"></span>' +
                    '<span class="t-xs">' + FMT.esc(item.label) + '</span></span>' +
                    '<span class="t-xs bold num">' + Math.round((item.value / total) * 100) + '%</span></div>';
            }).join('') + '</div>';

        return '<div class="stack-4"><div class="donut" style="max-width:' + size + 'px">' +
            '<svg viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Donut chart">' + svg + '</svg>' +
            centre + '</div>' + list + '</div>';
    }


    /* ======================================================================
       GAUGE (a half-circle dial showing one percentage)
       ====================================================================== */
    function gauge(o) {
        o = o || {};
        var value = Math.max(0, Math.min(100, o.value || 0));
        var size = o.size || 170;
        var thickness = o.thickness || 14;
        var tone = o.tone || 'var(--brand)';

        var radius = (size - thickness) / 2;
        var arcLength = Math.PI * radius;              // half a circle
        var filled = (value / 100) * arcLength;

        // An SVG arc from the left edge, over the top, to the right edge
        var arc = 'M ' + (size / 2 - radius) + ' ' + (size / 2) +
            ' A ' + radius + ' ' + radius + ' 0 0 1 ' + (size / 2 + radius) + ' ' + (size / 2);

        var svg = '<path d="' + arc + '" fill="none" stroke="var(--surface-3)" ' +
            'stroke-width="' + thickness + '" stroke-linecap="round"/>' +
            '<path d="' + arc + '" fill="none" stroke="' + tone + '" stroke-width="' + thickness + '" ' +
            'stroke-linecap="round" stroke-dasharray="' + filled + ' ' + arcLength + '"/>';

        return '<div class="stack-2" style="align-items:center">' +
            '<div class="chart" style="max-width:' + size + 'px">' +
            '<svg viewBox="0 0 ' + size + ' ' + (size * 0.62) + '" role="img" ' +
            'aria-label="' + FMT.esc((o.label || 'Value') + ': ' + Math.round(value) + '%') + '">' + svg + '</svg>' +
            '</div>' +
            '<div class="center" style="margin-top:-18px">' +
            '<div class="donut-value">' + Math.round(value) + '%</div>' +
            (o.label ? '<div class="donut-label">' + FMT.esc(o.label) + '</div>' : '') +
            '</div></div>';
    }


    /* ======================================================================
       HORIZONTAL BARS
       Good for ranked lists, and much easier to read than a pie on a phone.
       Built from our .progress component rather than SVG.
       ====================================================================== */
    function hbars(items, o) {
        o = o || {};
        var format = o.format || function (v) { return v + '%'; };
        var max = o.max || Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));

        return '<div class="stack-4">' + items.map(function (item) {
            var percent = Math.round((item.value / max) * 100);
            return '<div class="meter"><div class="meter-head">' +
                '<span class="meter-label">' + FMT.esc(item.label) + '</span>' +
                '<span class="meter-val">' + FMT.esc(format(item.value)) + '</span></div>' +
                '<div class="progress"><div class="bar" data-w="' + percent + '"' +
                (item.color ? ' style="background-image:none;background:' + item.color + '"' : '') +
                '></div></div></div>';
        }).join('') + '</div>';
    }


    return {
        sparkline: sparkline,
        line: line,
        bars: bars,
        donut: donut,
        gauge: gauge,
        hbars: hbars,
        legend: legend
    };

})();
