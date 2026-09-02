/* ==========================================================================
   ui.js
   --------------------------------------------------------------------------
   Our reusable component library.

   HOW IT WORKS
   Each function below returns a STRING of HTML. Pages join those strings
   together and hand the result to jQuery, e.g.

       $('#root').html(UI.card({ title: 'Hello' }, 'Some content'));

   Why strings instead of building elements one by one? It is far less code,
   it reads like HTML, and it is easy to change during a hackathon.

   CLICKS
   We do NOT attach a click handler to each button as we build it, because the
   buttons are constantly rebuilt. Instead every clickable thing gets a
   data-act="name" attribute, and one delegated handler in app.js listens for
   all of them:

       $(document).on('click', '[data-act="open-customer"]', function () { ... });

   This is called "event delegation": the listener lives on the document and
   still works for elements created later. It is the standard jQuery approach.
   ========================================================================== */

var UI = (function () {

    /* ======================================================================
       ICONS
       Small inline SVG icons. Stored as just the inner shapes; the icon()
       function wraps them in the <svg> tag.
       They use stroke="currentColor", which means each icon automatically
       takes the text colour of whatever contains it.
       ====================================================================== */
    var ICONS = {
        // navigation
        grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/>',
        home: '<path d="M3 9.5 12 3l9 6.5V20a1.8 1.8 0 0 1-1.8 1.8H4.8A1.8 1.8 0 0 1 3 20z"/><polyline points="9.2 21.8 9.2 12.6 14.8 12.6 14.8 21.8"/>',
        users: '<path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9.5" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
        user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
        userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="17 11 19 13 23 9"/>',
        briefcase: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>',
        fileText: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
        clipboard: '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>',
        layers: '<polygon points="12 2 2 7 12 12 22 7"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
        logOut: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
        logIn: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>',
        trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
        settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',

        // actions
        search: '<circle cx="11" cy="11" r="7.5"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
        plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
        x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        check: '<polyline points="20 6 9 17 4 12"/>',
        checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9"/>',
        refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
        share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
        externalLink: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
        bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
        edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1z"/>',
        download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',

        // arrows
        chevronDown: '<polyline points="6 9 12 15 18 9"/>',
        chevronUp: '<polyline points="18 15 12 9 6 15"/>',
        chevronRight: '<polyline points="9 18 15 12 9 6"/>',
        chevronLeft: '<polyline points="15 18 9 12 15 6"/>',
        arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
        arrowLeft: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
        arrowUpRight: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>',

        // status
        bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
        alertCircle: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
        alertTriangle: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
        helpCircle: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
        shieldCheck: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11.5 14.5 15.5 9.5"/>',
        lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
        eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',

        // data
        activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
        trendingUp: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
        trendingDown: '<polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/>',
        barChart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
        pieChart: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
        target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
        sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
        percent: '<line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
        dollarSign: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
        creditCard: '<rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
        scale: '<line x1="12" y1="3" x2="12" y2="21"/><path d="M6 8 3 14h6z"/><path d="M18 8l-3 6h6z"/><line x1="6" y1="8" x2="18" y2="8"/><path d="M8 21h8"/>',

        // time and place
        calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
        clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6.5 12 12 16 14"/>',
        mapPin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',

        // communication
        video: '<polygon points="23 7 16 12 23 17"/><rect x="1" y="5" width="15" height="14" rx="2"/>',
        videoOff: '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>',
        mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
        micOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
        phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
        phoneOff: '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-3.11-2.62m-2.67-3.4A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/>',
        messageCircle: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/>',
        messageSquare: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
        mail: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22 6 12 13 2 6"/>',
        monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
        volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>',
        maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',

        // domain
        umbrella: '<path d="M23 12a11 11 0 0 0-22 0z"/><path d="M12 12v7a3 3 0 0 0 6 0"/>',
        heart: '<path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l8.84 8.84 8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/>',
        award: '<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>',
        star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
        bookOpen: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
        zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10"/>',
        thumbsUp: '<path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>',
        inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
        compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88"/>',

        // theme
        sun: '<circle cx="12" cy="12" r="4.5"/><line x1="12" y1="1.5" x2="12" y2="3.5"/><line x1="12" y1="20.5" x2="12" y2="22.5"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1.5" y1="12" x2="3.5" y2="12"/><line x1="20.5" y1="12" x2="22.5" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
        moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',

        // the AI sparkle
        sparkles: '<path d="M11.2 3.3a.55.55 0 0 1 1.04 0l1.36 3.62a.55.55 0 0 0 .32.32l3.62 1.36a.55.55 0 0 1 0 1.04l-3.62 1.36a.55.55 0 0 0-.32.32l-1.36 3.62a.55.55 0 0 1-1.04 0L9.88 11.3a.55.55 0 0 0-.32-.32L5.94 9.62a.55.55 0 0 1 0-1.04L9.56 7.2a.55.55 0 0 0 .32-.32z"/><path d="M18.4 14.6l.62 1.66 1.66.62-1.66.62-.62 1.66-.62-1.66-1.66-.62 1.66-.62z"/><path d="M5.6 15.2l.44 1.16 1.16.44-1.16.44-.44 1.16-.44-1.16L4 16.8l1.16-.44z"/>',

        // messaging + attachments
        paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
        image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
        file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',

        /* Added for the documents screen. Same 24x24 Feather geometry and the
           same 2px stroke as everything above, so they sit correctly next to
           the rest without any per-icon adjustment. */
        folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
        upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
        checkCheck: '<polyline points="1 12 5.5 16.5 12 10"/><polyline points="10 15 12.5 17.5 22 8"/>',
        userX: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/>',
        userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
        camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
        flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
        smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>'
    };

    /* Returns one icon as an <svg> string.
       size is in pixels. aria-hidden hides it from screen readers, because
       icons here are always next to real text. */
    function icon(name, size) {
        var shapes = ICONS[name] || ICONS.helpCircle;
        var px = size || 18;
        return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
            'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ' +
            'aria-hidden="true" focusable="false">' + shapes + '</svg>';
    }


    /* ======================================================================
       SMALL INTERNAL HELPERS
       ====================================================================== */

    // Turns { id:'x', act:'go' } into ' data-id="x" data-act="go"'
    function dataAttrs(obj) {
        if (!obj) { return ''; }
        var out = '';
        for (var key in obj) {
            if (obj[key] !== null && obj[key] !== undefined && obj[key] !== false) {
                out += ' data-' + key + '="' + FMT.esc(obj[key]) + '"';
            }
        }
        return out;
    }

    // Joins an array of HTML strings. Ignores empty/false entries so we can
    // write things like [ maybeThis && html, alwaysThis ]
    function join(parts) {
        return (parts || []).filter(function (p) { return !!p; }).join('');
    }


    /* ======================================================================
       PRUWISE WORDMARK

       The product name. "PRU" is always brand red; "Wise" uses
       var(--text-strong), which is near-black on the light theme and white on
       the dark theme - so it flips automatically with no extra code.
       ====================================================================== */
    function pruwise(opts) {
        opts = opts || {};
        var cls = 'pruwise' +
            (opts.onBrand ? ' pruwise-onbrand' : '') +
            (opts.inline ? ' pruwise-inline' : '');
        // aria-label keeps screen readers from reading it as two words
        return '<span class="' + cls + '" aria-label="PRUWise">' +
            '<span class="pru">PRU</span><span class="wise">Wise</span></span>';
    }


    /* ======================================================================
       LOGO LOCKUP

       Layout:   [ logo.svg ]  |  PRUWise
                                  AI INSURANCE NAVIGATOR

       The <img> tries each path in LOGO_PATHS. If none load, the browser fires
       "onerror" and we swap in a dashed LOGO box so the layout never breaks.

       Options:
         size      'sm' | 'md' | 'lg' | 'xl'   (default 'md')
         withText  false to show the logo on its own
         subtitle  the small uppercase line under the wordmark
         onBrand   true when it sits on the red panel
         href      renders a link instead of a plain span
       ====================================================================== */
    var LOGO_PATHS = [
        'public/assets/brand/logo.svg',   // where your file lives
        'assets/brand/logo.svg'           // fallback if served from /public
    ];

    function logo(opts) {
        opts = opts || {};
        var size = ' logo-' + (opts.size || 'md');
        var onBrand = opts.onBrand ? ' logo-onbrand' : '';

        var img = '<span class="logo-mark">' +
            '<img class="logo-img" src="' + LOGO_PATHS[0] + '" alt="Prudential" ' +
            'data-try="0" onerror="UI.logoFallback(this)">' +
            '</span>';

        // The wordmark block, shown unless withText is explicitly false
        var text = '';
        if (opts.withText !== false) {
            text = '<span class="logo-rule" aria-hidden="true"></span>' +
                '<span class="logo-text">' +
                pruwise({ onBrand: opts.onBrand }) +
                (opts.subtitle === null ? '' :
                    '<span class="logo-sub">' + FMT.esc(opts.subtitle || 'AI Insurance Navigator') + '</span>') +
                '</span>';
        }

        var inner = img + text;
        var cls = 'logo' + size + onBrand + (opts.cls ? ' ' + opts.cls : '');

        if (opts.href) {
            return '<a class="' + cls + '" href="' + opts.href + '" aria-label="PRUWise home">' + inner + '</a>';
        }
        return '<span class="' + cls + '">' + inner + '</span>';
    }

    // Called by the <img onerror> above. Tries the next path, then gives up.
    function logoFallback(imgEl) {
        var next = Number(imgEl.getAttribute('data-try')) + 1;
        if (next < LOGO_PATHS.length) {
            imgEl.setAttribute('data-try', String(next));
            imgEl.src = LOGO_PATHS[next];
            return;
        }
        var box = document.createElement('span');
        box.className = 'logo-fallback';
        box.textContent = 'LOGO';
        if (imgEl.parentNode) {
            imgEl.parentNode.replaceChild(box, imgEl);
        }
    }


    /* ======================================================================
       BUTTONS
       btn({ label:'Save', variant:'primary', icon:'check', act:'save' })
       ====================================================================== */
    function btn(o) {
        o = o || {};
        var cls = 'btn btn-' + (o.variant || 'primary') +
            (o.size ? ' btn-' + o.size : '') +
            (o.block ? ' btn-block' : '') +
            (o.cls ? ' ' + o.cls : '');

        var inner = join([
            o.icon ? icon(o.icon, o.size === 'lg' ? 18 : 15) : '',
            o.label ? '<span>' + FMT.esc(o.label) + '</span>' : '',
            o.iconRight ? icon(o.iconRight, o.size === 'lg' ? 18 : 15) : ''
        ]);

        var attrs = dataAttrs(o.data) + (o.act ? ' data-act="' + o.act + '"' : '');
        var title = o.title ? ' title="' + FMT.esc(o.title) + '"' : '';

        // If a href is given we render a link instead of a button, so that
        // hash navigation and "open in new tab" both work naturally.
        if (o.href) {
            return '<a class="' + cls + '" href="' + o.href + '"' + attrs + title + '>' + inner + '</a>';
        }
        // type defaults to "button" so a button inside a form never submits it
        // by accident. Pass type:'submit' when you DO want it to submit.
        return '<button type="' + (o.type || 'button') + '" class="' + cls + '"' + attrs + title +
            (o.disabled ? ' disabled' : '') + '>' + inner + '</button>';
    }

    // Icon-only button
    function iconBtn(o) {
        o = o || {};
        var cls = 'iconbtn' + (o.size === 'sm' ? ' iconbtn-sm' : '') +
            (o.bordered ? ' iconbtn-bordered' : '') + (o.cls ? ' ' + o.cls : '');
        var inner = icon(o.icon, o.iconSize || 18) + (o.dot ? '<span class="dot"></span>' : '');
        var attrs = dataAttrs(o.data) + (o.act ? ' data-act="' + o.act + '"' : '');
        var label = ' aria-label="' + FMT.esc(o.label || o.icon) + '" title="' + FMT.esc(o.label || '') + '"';

        if (o.href) {
            return '<a class="' + cls + '" href="' + o.href + '"' + attrs + label + '>' + inner + '</a>';
        }
        return '<button type="button" class="' + cls + '"' + attrs + label + '>' + inner + '</button>';
    }

    function chip(o) {
        o = o || {};
        return '<button type="button" class="chip' + (o.on ? ' is-on' : '') + '"' +
            dataAttrs(o.data) + (o.act ? ' data-act="' + o.act + '"' : '') +
            ' aria-pressed="' + (o.on ? 'true' : 'false') + '">' +
            (o.icon ? icon(o.icon, 13) : '') +
            '<span>' + FMT.esc(o.label) + '</span></button>';
    }

    /* ======================================================================
       THE EXCLAMATION MARKER

       An exclamation mark that says why it is there.

       ---------------------------------------------------------------------
       IT IS A BUTTON, NOT A HOVER TARGET
       ---------------------------------------------------------------------
       The obvious build is a div with a :hover rule and a title attribute. That
       version is unusable in the two situations that matter most: a phone has no
       hover at all, so the explanation would be unreachable, and a keyboard user
       would never know the marker existed.

       So it is a real <button> with aria-expanded and the panel is exposed on
       hover, on focus AND on click - see .warn-dot in css/components.css. The
       hover is the convenience; the button is the feature.

       ---------------------------------------------------------------------
       IT NEVER APPEARS EMPTY
       ---------------------------------------------------------------------
       Returns '' when there is nothing to report. An exclamation mark that opens
       to say "everything is fine" trains people to ignore exclamation marks, and
       the next one will be the real one.

       opts: { warnings }  - straight from DATA.planWarnings()
             { label }     - what the marker is about, for the screen reader
       ====================================================================== */
    function warnDot(opts) {
        var o = opts || {};
        var w = o.warnings;

        if (!w || !w.count) { return ''; }

        var tone = w.tone === 'bad' ? 'bad' : 'warn';

        /* The heading states the conclusion. A panel that opens into a list of
           figures makes the reader do the work of deciding whether it matters. */
        var heading = w.blocked
            ? 'Worth reviewing, but not by adding a premium'
            : (w.count === 1
                ? 'One thing here could be better covered'
                : w.count + ' things here could be better covered');

        var rows = w.findings.map(function (f) {
            return '<div class="warn-row">' +
                '<div class="warn-row-title">' + FMT.esc(f.title) + '</div>' +
                (f.figure ? '<div class="warn-row-figure">' + FMT.esc(f.figure) + '</div>' : '') +
                '<div class="warn-row-detail">' + FMT.esc(f.detail) + '</div>' +

                /* The product is named only when DATA.planWarnings decided naming
                   one was appropriate - it withholds them when the person has no
                   room for another premium. */
                (f.productName
                    ? '<div class="warn-row-plan">' + icon('arrowRight', 12) +
                      '<span>' + FMT.esc(f.productName) + ' is the plan built for this</span></div>'
                    : '') +
                '</div>';
        }).join('');

        return '<span class="warn-dot warn-dot-' + tone + '">' +
            '<button type="button" class="warn-dot-btn" aria-expanded="false" ' +
            'data-act="warn-toggle" aria-label="' +
            FMT.esc((o.label ? o.label + ': ' : '') + heading) + '">' +
            icon('alertTriangle', 13) +
            '</button>' +
            '<span class="warn-pop" role="status">' +
            '<span class="warn-pop-head">' + FMT.esc(heading) + '</span>' +
            rows +
            '<span class="warn-pop-foot">Worked out from the figures on this ' +
            'record. Nothing here has been sent to anybody.</span>' +
            '</span>' +
            '</span>';
    }

    /* ======================================================================
       READING THINGS ALOUD

       REQUESTED: "for the chat have a text to speech function for those who don't
       want to talk".

       -------------------------------------------------------------------------
       THERE WAS ALREADY A SWITCH FOR THIS AND IT DID NOTHING
       -------------------------------------------------------------------------
       Settings has offered "Read PRUWise suggestions aloud during a call" for
       several rounds, the preference saved to the database, and nothing anywhere
       in the app had ever called speechSynthesis. A toggle that reports a state it
       does not have is worse than a missing feature, because somebody turns it on
       and concludes the audio is broken.

       -------------------------------------------------------------------------
       IT ALL HAPPENS IN THE BROWSER
       -------------------------------------------------------------------------
       window.speechSynthesis, no request, no audio uploaded, nothing sent to a
       third party. That is worth stating plainly next to the control, because
       "text to speech" in 2026 usually means posting text to somebody's API, and a
       client's financial questions are not text to be sending anywhere.

       WHAT IS NOT PROMISED: which voice. The installed voices are the operating
       system's, they differ on every machine, and none is guaranteed for any
       language. So a language is REQUESTED and the browser answers with what it
       has - see pickVoice().
       ====================================================================== */
    var speech = (function () {
        var current = null;

        function supported() {
            return !!(window.speechSynthesis && window.SpeechSynthesisUtterance);
        }

        /* The closest installed voice for a language tag, or null to let the
           browser choose. An exact match first ('zh-SG'), then the language alone
           ('zh'), because a Mandarin voice from anywhere reads Mandarin far better
           than an English one does. */
        function pickVoice(lang) {
            if (!supported() || !lang) { return null; }

            var voices = window.speechSynthesis.getVoices() || [];
            var want = String(lang).toLowerCase();
            var base = want.split('-')[0];
            var i;

            for (i = 0; i < voices.length; i++) {
                if (String(voices[i].lang || '').toLowerCase() === want) { return voices[i]; }
            }
            for (i = 0; i < voices.length; i++) {
                if (String(voices[i].lang || '').toLowerCase().indexOf(base) === 0) {
                    return voices[i];
                }
            }
            return null;
        }

        function stop() {
            if (!supported()) { return; }

            current = null;

            /* cancel() rather than pause(). A paused queue resumes on the next
               speak() and reads the previous item first, which sounds like the app
               ignoring what was just asked for. */
            try { window.speechSynthesis.cancel(); } catch (e) { /* not fatal */ }

            $('[data-act="speak"]').removeClass('is-speaking')
                .attr('aria-pressed', 'false');
        }

        /* opts: { lang, onEnd }.  Returns false when it could not speak, so a
           caller can say so rather than appearing to work. */
        function say(text, opts) {
            var o = opts || {};
            var clean = String(text == null ? '' : text).trim();

            if (!supported() || clean === '') { return false; }

            /* ONE AT A TIME. Tapping a second message should read the second
               message, not queue it behind the first - speechSynthesis queues by
               default and a queue is never what somebody wanted here. */
            stop();

            var utter = new window.SpeechSynthesisUtterance(clean);
            var voice = pickVoice(o.lang);

            if (voice) { utter.voice = voice; }
            if (o.lang) { utter.lang = o.lang; }

            /* Slightly under normal pace. This reads financial wording to somebody
               who may be taking it in for the first time, and the default rate is
               tuned for notifications. */
            utter.rate = 0.95;

            utter.onend = function () {
                current = null;
                if (o.onEnd) { o.onEnd(); }
            };

            /* A failed utterance must clear the state too, or the button stays
               stuck showing "speaking" for the rest of the visit. */
            utter.onerror = utter.onend;

            current = utter;

            try {
                window.speechSynthesis.speak(utter);
            } catch (e) {
                current = null;
                return false;
            }
            return true;
        }

        function busy() { return !!current; }

        return { supported: supported, say: say, stop: stop, busy: busy };
    })();

    /* The read-aloud button. Rendered only where speech is actually available, so
       nobody is offered a control that cannot work.

       The text travels in a data attribute rather than being scraped from the
       bubble: a PRUWise answer is built from bullets, chips and callouts, and
       reading the visible text would read the button labels out too. */
    function speakBtn(text, opts) {
        var o = opts || {};

        if (!speech.supported()) { return ''; }

        var clean = String(text == null ? '' : text).trim();
        if (clean === '') { return ''; }

        return '<button type="button" class="speak-btn" data-act="speak" ' +
            'aria-pressed="false" ' +
            (o.lang ? 'data-lang="' + FMT.esc(o.lang) + '" ' : '') +
            'data-text="' + FMT.esc(clean) + '" ' +
            'title="Read this aloud" aria-label="Read this message aloud">' +
            icon('volume', 13) + '<span>Read aloud</span></button>';
    }

    function badge(text, tone) {
        return '<span class="badge' + (tone ? ' badge-' + tone : '') + '">' + FMT.esc(text) + '</span>';
    }

    function dotBadge(text, tone) {
        return '<span class="badge' + (tone ? ' badge-' + tone : '') + '"><i></i>' + FMT.esc(text) + '</span>';
    }

    // The "AI GENERATED" marker
    function aitag(label) {
        return '<span class="aitag">' + icon('sparkles', 12) + FMT.esc(label || 'AI generated') + '</span>';
    }


    /* ======================================================================
       AVATAR + PERSON
       ====================================================================== */
    function avatar(name, size, opts) {
        opts = opts || {};
        var cls = 'avatar' + (size ? ' avatar-' + size : '') + ' ' + FMT.avatarTint(opts.seed || name);
        return '<span class="' + cls + '" title="' + FMT.esc(name) + '" aria-hidden="true">' +
            FMT.esc(FMT.initials(name)) +
            (opts.online ? '<span class="online"></span>' : '') +
            '</span>';
    }

    function person(o) {
        o = o || {};
        return '<div class="person">' +
            avatar(o.name, o.size, { seed: o.seed, online: o.online }) +
            '<span class="person-text">' +
            '<span class="person-name">' + FMT.esc(o.name) + '</span>' +
            (o.meta ? '<span class="person-meta">' + FMT.esc(o.meta) + '</span>' : '') +
            '</span></div>';
    }


    /* ======================================================================
       CARDS
       card({ title:'...', sub:'...', actions:'<html>' }, bodyHtml)
       If no title/actions are given you get a plain padded card.
       ====================================================================== */
    function card(o, body) {
        o = o || {};
        var cls = 'card' +
            (o.variant ? ' card-' + o.variant : '') +
            (o.hover ? ' card-hover' : '') +
            (o.cls ? ' ' + o.cls : '');

        var hasHead = !!(o.title || o.sub || o.actions);

        var head = hasHead
            ? '<div class="card-head">' +
            '<div class="row-2">' +
            (o.icon ? '<span class="card-icon">' + icon(o.icon, 16) + '</span>' : '') +
            '<div class="card-titles">' +
            (o.title ? '<div class="card-title">' + FMT.esc(o.title) + '</div>' : '') +
            /* subId lets a page update the subtitle later without redrawing
               the card, e.g. a live "12 lines" counter on the transcript. */
            (o.sub ? '<div class="card-sub"' + (o.subId ? ' id="' + o.subId + '"' : '') + '>' +
                FMT.esc(o.sub) + '</div>' : '') +
            '</div></div>' +
            (o.actions ? '<div class="card-actions">' + o.actions + '</div>' : '') +
            '</div>'
            : '';

        /* The body always gets .card-body, which supplies the padding and
           stacks its children with a gap. So a card with no header still
           looks correctly padded. */
        var content = '<div class="card-body">' + (body || '') + '</div>';
        var foot = o.foot ? '<div class="card-foot">' + o.foot + '</div>' : '';

        var openTag = o.href
            ? '<a class="' + cls + '" href="' + o.href + '"' + dataAttrs(o.data) + '>'
            : '<div class="' + cls + '"' + dataAttrs(o.data) + (o.act ? ' data-act="' + o.act + '"' : '') + '>';
        var closeTag = o.href ? '</a>' : '</div>';

        return openTag + head + content + foot + closeTag;
    }

    // Section heading above a group of cards
    function secHead(o) {
        o = o || {};
        return '<div class="sec-head"><div class="stack-2" style="gap:2px">' +
            (o.eyebrow ? '<div class="eyebrow">' + FMT.esc(o.eyebrow) + '</div>' : '') +
            '<h2 class="h4">' + FMT.esc(o.title) + '</h2>' +

            /* `sub` is ESCAPED and stays that way - it often carries a name or a
               count that came from somewhere else.

               `subHtml` is the deliberate opt-out, for the one case that needs it: a
               subtitle containing an element the page updates later, such as a count
               that starts as a placeholder and is corrected when the server answers.
               Two names rather than one flag, so choosing the unescaped path is
               visible at the call site instead of hidden in an options object. */
            (o.subHtml
                ? '<div class="t-sm muted">' + o.subHtml + '</div>'
                : (o.sub ? '<div class="t-sm muted">' + FMT.esc(o.sub) + '</div>' : '')) +
            '</div>' +
            (o.actions ? '<div class="card-actions">' + o.actions + '</div>' : '') +
            '</div>';
    }

    // Page title block
    /* `sub` is escaped and stays that way. `subHtml` is the explicit opt-out, for a
       subtitle containing an element the page fills in later - a count that has to
       come from the server, typically. Two names rather than a flag, so the
       unescaped path is visible at the call site. Same arrangement as secHead. */
    function pageHead(o) {
        o = o || {};
        return '<div class="page-head">' +
            (o.crumbs ? o.crumbs : '') +
            '<div class="page-head-row"><div class="page-head-text">' +
            (o.eyebrow ? '<div class="eyebrow">' + FMT.esc(o.eyebrow) + '</div>' : '') +
            /* `titleAfter` is RAW HTML placed inside the heading, for a marker
               that belongs to the title rather than beside it - UI.warnDot() is
               the reason it exists. Inside the h1 so it inherits the baseline and
               cannot end up on its own line, and named separately from `title`
               for the same reason `subHtml` is: the unescaped path should be
               visible where it is used. */
            '<h1 class="h2">' + FMT.esc(o.title) +
            (o.titleAfter ? o.titleAfter : '') + '</h1>' +
            (o.subHtml ? '<p class="lead">' + o.subHtml + '</p>' : '') +
            (o.sub ? '<p class="lead">' + FMT.esc(o.sub) + '</p>' : '') +
            '</div>' +
            (o.actions ? '<div class="card-actions">' + o.actions + '</div>' : '') +
            '</div></div>';
    }


    /* ======================================================================
       STAT / KPI CARD
       ====================================================================== */
    function stat(o) {
        o = o || {};
        var deltaHtml = '';
        if (typeof o.delta === 'number') {
            var up = o.delta >= 0;
            deltaHtml = '<span class="delta ' + (up ? 'delta-up' : 'delta-down') + '">' +
                icon(up ? 'trendingUp' : 'trendingDown', 11) +
                (up ? '+' : '') + o.delta + '%</span>';
        }

        return '<div class="card stat">' +
            '<div class="stat-top">' +
            '<span class="stat-label">' + FMT.esc(o.label) + '</span>' +
            (o.icon ? '<span class="card-icon">' + icon(o.icon, 16) + '</span>' : '') +
            '</div>' +
            '<div class="stat-value">' + FMT.esc(String(o.value) + (o.suffix || '')) + '</div>' +
            '<div class="stat-meta">' + deltaHtml +
            (o.deltaLabel ? '<span>' + FMT.esc(o.deltaLabel) + '</span>' : '') + '</div>' +
            (o.spark ? '<div style="margin-top:4px">' + CHARTS.sparkline(o.spark) + '</div>' : '') +
            '</div>';
    }


    /* ======================================================================
       SMALL DISPLAY PIECES
       ====================================================================== */
    function fact(label, value) {
        return '<div class="fact"><span class="fact-label">' + FMT.esc(label) + '</span>' +
            '<span class="fact-value">' + FMT.esc(value) + '</span></div>';
    }

    // facts([['Income','$132,000'], ['Dependants','2']])
    function facts(pairs) {
        return '<div class="facts">' + pairs.filter(Boolean).map(function (p) {
            return fact(p[0], p[1]);
        }).join('') + '</div>';
    }

    // kv([['Policy number','PS-4471'], ...])
    function kv(pairs) {
        return '<div class="kv">' + pairs.filter(Boolean).map(function (p) {
            return '<span class="k">' + FMT.esc(p[0]) + '</span><span class="v">' + FMT.esc(p[1]) + '</span>';
        }).join('') + '</div>';
    }

    function figure(label, value, small) {
        return '<div class="figure"><span class="figure-label">' + FMT.esc(label) + '</span>' +
            '<span class="figure-value' + (small ? ' small' : '') + '">' + FMT.esc(value) + '</span></div>';
    }

    function callout(o) {
        o = o || {};
        var iconName = o.icon || ({ brand: 'sparkles', ok: 'checkCircle', warn: 'alertTriangle', bad: 'alertCircle', info: 'info' }[o.tone] || 'info');
        return '<div class="callout callout-' + (o.tone || 'brand') + '">' +
            icon(iconName, 16) +
            '<div class="stack-2" style="gap:2px">' +
            (o.title ? '<div class="callout-title">' + FMT.esc(o.title) + '</div>' : '') +
            '<div class="callout-text">' + FMT.esc(o.text) + '</div>' +
            '</div></div>';
    }

    /* THE COMPLIANCE WORDING THAT SITS NEAR ANY AI OUTPUT

       Two sets, because the same sentence cannot serve both audiences.

       Telling a customer to "review this with your Financial Representative" is
       exactly right. Telling a Financial Representative the same thing is
       nonsense - they ARE the licensed adviser, and being told to go and ask one
       makes the whole product look like it does not know who it is talking to.

       So the representative gets the wording that is actually true for them:
       verify the figures, you are the one signing off on this.                 */
    var DISCLAIMERS = {
        short: 'AI-generated guidance. Please review it with your Financial Representative before deciding.',
        long: 'This is AI-generated guidance based on the information on file. It is not financial advice and it does not guarantee any outcome. All figures shown are illustrations only. Please review every recommendation with your licensed Financial Representative before making a decision.',
        sim: 'Projections are illustrations. They assume the stated variables hold true and are not a guarantee of future value.'
    };

    var FR_DISCLAIMERS = {
        short: 'AI-generated from the client record. Verify the figures before you advise on them.',
        long: 'This is AI-generated guidance drawn from the information on file. All figures are illustrations, not quotations, and nothing here is a substitute for the policy documents. You are the licensed adviser: check the numbers and the product terms before you present anything.',
        sim: 'Projections are illustrations. They assume the stated variables hold true and are not a guarantee of future value.'
    };

    /* Picks the right set from the signed-in role. Read at render time rather
       than at load time, because ui.js loads before app.js creates STATE. */
    function disclaimer(kind) {
        var isFr = (typeof STATE !== 'undefined' && STATE && STATE.session &&
            STATE.session.role === 'fr');

        var set = isFr ? FR_DISCLAIMERS : DISCLAIMERS;
        var text = set[kind || 'short'] || DISCLAIMERS[kind || 'short'];

        return '<div class="disclaimer" role="note">' + icon('info', 14) +
            '<span>' + text + '</span></div>';
    }

    // Expandable panel. Uses <details>, so opening/closing needs no JavaScript.
    function expand(summary, bodyHtml, opts) {
        opts = opts || {};
        return '<details class="expand"' + (opts.open ? ' open' : '') + '>' +
            '<summary>' + icon(opts.icon || 'helpCircle', 15) +
            '<span>' + FMT.esc(summary) + '</span>' +
            '<span class="chev">' + icon('chevronDown', 16) + '</span></summary>' +
            '<div class="expand-body">' + bodyHtml + '</div></details>';
    }

    /* Progress bar.
       We render width:0 and let jQuery set the real width just after the HTML
       lands on the page, so the bar animates instead of appearing full. */
    function progress(percent, opts) {
        opts = opts || {};
        var value = Math.max(0, Math.min(100, Math.round(percent)));
        return '<div class="progress' + (opts.thin ? ' thin' : '') + '" role="progressbar" ' +
            'aria-valuenow="' + value + '" aria-valuemin="0" aria-valuemax="100">' +
            '<div class="bar' + (opts.tone ? ' ' + opts.tone : '') + '" data-w="' + value + '"></div></div>';
    }

    function meter(o) {
        o = o || {};
        return '<div class="meter"><div class="meter-head">' +
            '<span class="meter-label">' + FMT.esc(o.label) + '</span>' +
            '<span class="meter-val">' + FMT.esc(o.value) + '</span></div>' +
            progress(o.percent, { tone: o.tone, thin: o.thin }) + '</div>';
    }

    /* Coverage bars: dashed outline = the cover the calculation suggests,
       solid red = what is actually in place.

       Takes a SEEDED CUSTOMER from js/data.js. It only converts that customer
       into coverage lines and hands them to coverageLineBars() below - the
       drawing is shared, because a real account's lines come from the server
       instead and must look identical. */
    function coverageBars(customer) {
        return coverageLineBars(DATA.numericCoverage(customer));
    }

    /* The same bars, drawn from lines that are already in the right shape:

           { label, current, recommended, monthly, gap }

       finances_needs() in php/lib/finances.php returns exactly this, on purpose,
       so a self-registered customer's real protection gap renders through the
       same tested markup and CSS as the demo customers' sample gap. One set of
       bars, two sources - rather than a second near-copy that drifts. */
    function coverageLineBars(lines) {
        lines = lines || [];
        var max = 1;
        lines.forEach(function (l) { max = Math.max(max, l.current, l.recommended); });

        var rows = lines.map(function (line) {
            var havePct = Math.round((line.current / max) * 100);
            var needPct = Math.round((line.recommended / max) * 100);
            var suffix = line.monthly ? ' mo' : '';
            return '<div class="stack-2">' +
                '<div class="meter-head">' +
                '<span class="meter-label">' + FMT.esc(line.label) + '</span>' +
                '<span class="meter-val">' + FMT.moneyShort(line.current) + ' / ' + FMT.moneyShort(line.recommended) + suffix + '</span>' +
                '</div>' +
                '<div class="cbar">' +
                '<div class="cbar-need" style="width:' + needPct + '%"></div>' +
                '<div class="cbar-have" data-w="' + havePct + '"></div>' +
                '</div>' +
                (line.gap > 0
                    ? '<div class="t-xs t-warn semi">' + FMT.money(line.gap) + ' below the suggested cover</div>'
                    : '<div class="t-xs t-ok semi">Meets the suggested cover</div>') +
                '</div>';
        }).join('');

        var legend = '<div class="legend">' +
            '<span class="legend-item"><span class="swatch" style="background:var(--brand)"></span>In place today</span>' +
            '<span class="legend-item"><span class="swatch" style="background:var(--brand-soft-2);border:1px dashed var(--brand-border)"></span>Suggested cover</span>' +
            '</div>';

        return '<div class="stack-4">' + rows + legend + '</div>';
    }


    /* ======================================================================
       EMPTY / LOADING / ERROR STATES
       ====================================================================== */
    function state(o) {
        o = o || {};
        var inner = '<div class="state' + (o.bad ? ' is-bad' : '') + '">' +
            '<span class="state-icon">' + icon(o.icon || 'inbox', 26) + '</span>' +
            '<div class="state-title">' + FMT.esc(o.title) + '</div>' +
            (o.text ? '<div class="state-text">' + FMT.esc(o.text) + '</div>' : '') +
            (o.actions ? '<div class="card-actions" style="justify-content:center">' + o.actions + '</div>' : '') +
            '</div>';
        return o.plain ? inner : '<div class="card">' + inner + '</div>';
    }

    function emptyState(o) { return state(o); }

    function errorState(o) {
        o = o || {};
        return state({
            /* alertTriangle unless the caller knows better. "Taking too long" is
               a clock, not a warning triangle, and the icon is doing real work
               here - it is the first thing read. */
            icon: o.icon || 'alertTriangle',
            bad: true,
            title: o.title || 'Something went wrong',
            text: o.text || 'That content could not be loaded. This prototype uses mock data, so trying again usually clears it.',
            actions: o.actions !== undefined ? o.actions : btn({ label: 'Try again', variant: 'outline', icon: 'refresh', act: 'reload' }),
            plain: o.plain
        });
    }

    function loadingState(text) {
        return '<div class="card"><div class="state">' +
            '<span class="spinner spinner-lg"></span>' +
            '<div class="state-text">' + FMT.esc(text || 'Loading...') + '</div></div></div>';
    }

    // Grey shimmer placeholder card
    function skeletonCard(lines) {
        var count = lines || 3;
        var rows = '';
        for (var i = 0; i < count; i++) {
            rows += '<div class="skeleton line" style="width:' + (100 - i * 12) + '%"></div>';
        }
        return '<div class="card card-pad stack-3"><div class="skeleton title"></div>' + rows + '</div>';
    }

    function skeletonGrid(count) {
        var out = '';
        for (var i = 0; i < (count || 3); i++) { out += skeletonCard(3); }
        return '<div class="grid grid-md">' + out + '</div>';
    }


    /* ======================================================================
       TABLE
       Builds BOTH layouts and lets CSS decide which one to show:
         .tablet-up  -> the real <table>   (768px and wider)
         .phone-only -> stacked cards      (below 768px)

       columns: [{ key, label, num:true, hideOnPhone:true, render:function(row){} }]
       ====================================================================== */
    function table(o) {
        o = o || {};
        var cols = o.columns || [];
        var rows = o.rows || [];

        if (!rows.length) {
            return emptyState({
                icon: (o.empty && o.empty.icon) || 'inbox',
                title: (o.empty && o.empty.title) || 'Nothing to show yet',
                text: o.empty && o.empty.text,
                actions: o.empty && o.empty.actions,
                plain: true
            });
        }

        var cellValue = function (col, row) {
            return col.render ? col.render(row) : FMT.esc(row[col.key] === undefined ? '-' : row[col.key]);
        };

        /* --- the real table --- */
        var head = '<tr>' + cols.map(function (c) {
            return '<th scope="col"' + (c.num ? ' class="cell-num"' : '') + '>' + FMT.esc(c.label) + '</th>';
        }).join('') + '</tr>';

        var body = rows.map(function (row) {
            var attrs = o.rowAct
                ? ' class="clickable" tabindex="0" data-act="' + o.rowAct + '"' + dataAttrs(o.rowData ? o.rowData(row) : null)
                : '';
            return '<tr' + attrs + '>' + cols.map(function (c) {
                return '<td' + (c.num ? ' class="cell-num"' : '') + '>' + cellValue(c, row) + '</td>';
            }).join('') + '</tr>';
        }).join('');

        var realTable = '<div class="tablet-up">' +
            '<div class="table-wrap"><table class="table">' +
            (o.caption ? '<caption class="sr-only">' + FMT.esc(o.caption) + '</caption>' : '') +
            '<thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>' +
            (o.scrollHint === false ? '' :
                '<div class="scroll-hint">' + icon('arrowRight', 12) + 'Scroll sideways to see all columns</div>') +
            '</div>';

        /* --- phone cards --- */
        var detailCols = cols.filter(function (c, i) { return i > 0 && !c.hideOnPhone; });

        var cards = rows.map(function (row) {
            var attrs = o.rowAct
                ? ' tabindex="0" data-act="' + o.rowAct + '"' + dataAttrs(o.rowData ? o.rowData(row) : null) + ' style="cursor:pointer"'
                : '';
            var pairs = detailCols.map(function (c) {
                return '<span class="dcard-key">' + FMT.esc(c.label) + '</span>' +
                    '<span class="dcard-val">' + cellValue(c, row) + '</span>';
            }).join('');

            return '<div class="dcard"' + attrs + '>' +
                '<div class="dcard-head"><div class="semi t-sm truncate">' + cellValue(cols[0], row) + '</div>' +
                (o.rowAct ? icon('chevronRight', 15) : '') + '</div>' +
                '<div class="dcard-rows">' + pairs + '</div></div>';
        }).join('');

        return realTable + '<div class="phone-only"><div class="dcards">' + cards + '</div></div>';
    }

    // Coloured status pill for use inside tables
    function statusCell(status) {
        var tones = {
            'Accepted': 'ok', 'In discussion': 'info', 'Awaiting review': 'warn',
            'active': 'ok', 'confirmed': 'ok', 'pending': 'warn',
            'completed': 'info', 'renewal-due': 'warn', 'review-due': 'warn'
        };
        var tone = tones[status] || (String(status).indexOf('Declined') === 0 ? 'bad' : '');
        return dotBadge(status, tone);
    }


    /* ======================================================================
       TABS
       tabs('id', [{ id, label, icon, badge, render:function(){ return html } }])
       Only the active panel is built. app.js handles the clicks.
       ====================================================================== */
    var tabRenderers = {};   // remembers each tab set's render functions

    function tabs(setId, items, activeId) {
        tabRenderers[setId] = items;
        var active = activeId || items[0].id;

        var strip = items.map(function (t) {
            return '<button type="button" class="tab' + (t.id === active ? ' is-on' : '') + '" ' +
                'role="tab" aria-selected="' + (t.id === active ? 'true' : 'false') + '" ' +
                'data-act="tab" data-set="' + setId + '" data-tab="' + t.id + '">' +
                (t.icon ? icon(t.icon, 15) : '') +
                '<span>' + FMT.esc(t.label) + '</span>' +
                (t.badge ? '<span class="badge badge-brand">' + FMT.esc(t.badge) + '</span>' : '') +
                '</button>';
        }).join('');

        var panel = '';
        items.forEach(function (t) {
            if (t.id === active) { panel = t.render(); }
        });

        return '<div class="tabs" data-tabset="' + setId + '">' +
            '<div class="tab-list" role="tablist">' + strip + '</div>' +
            '<div class="tab-panel" role="tabpanel">' + panel + '</div></div>';
    }

    // Called by app.js when a tab is clicked
    function switchTab(setId, tabId) {
        var items = tabRenderers[setId];
        if (!items) { return; }

        var $set = $('[data-tabset="' + setId + '"]');
        $set.find('.tab').each(function () {
            var on = $(this).data('tab') === tabId;
            $(this).toggleClass('is-on', on).attr('aria-selected', on ? 'true' : 'false');
        });

        for (var i = 0; i < items.length; i++) {
            if (items[i].id === tabId) {
                $set.find('.tab-panel').html(items[i].render());
                break;
            }
        }
        animateBars();   // any new progress bars need their width setting

        /* ==================================================================
           A PANEL THAT HAS JUST BEEN BUILT MAY NEED FILLING FROM THE SERVER

           Only the ACTIVE panel exists in the DOM, which is what makes tabs cheap -
           the charts in one tab cost nothing until somebody asks for them. It also
           means a container inside an inactive tab is not there for a loader to
           find, and any after() that filled it on page load quietly did nothing.

           That is not hypothetical: the dashboard's client priority list is inside
           the "My clients" tab, and loadDashBook() bailed out on every first load
           because #fr-priority did not exist yet.

           So switching a tab announces itself. Anything that needs to top up a
           newly built panel listens for this rather than each tab set inventing its
           own callback - and the listeners read from a cache, so opening a tab
           three times is still one request. */
        $(document).trigger('pruwise:tab', [setId, tabId]);
    }


    /* ======================================================================
       POLICY CARD
       ====================================================================== */
    function policyCard(policy, opts) {
        opts = opts || {};
        var statusText = { active: 'Active', 'renewal-due': 'Renewal due', lapsed: 'Lapsed' }[policy.status] || policy.status;
        var statusTone = { active: 'ok', 'renewal-due': 'warn', lapsed: 'bad' }[policy.status] || 'info';

        var benefits = policy.benefits.slice(0, 3).map(function (b) {
            return '<span class="tick">' + icon('check', 13) + '<span>' + FMT.esc(b) + '</span></span>';
        }).join('');

        var details = kv([
            ['Policy number', policy.number],
            ['Start date', FMT.dateLong(policy.start)],
            ['Next renewal', FMT.dateLong(policy.renewal) + ' (' + FMT.relative(policy.renewal) + ')'],
            policy.maturity ? ['Matures', FMT.dateLong(policy.maturity)] : null,
            ['Payment', policy.payment]
        ]);

        var riders = policy.riders.length
            ? '<div class="stack-2"><span class="eyebrow">Riders attached</span>' +
            policy.riders.map(function (r) {
                return '<div class="t-xs"><strong>' + FMT.esc(r.name) + ':</strong> ' + FMT.esc(r.detail) + '</div>';
            }).join('') + '</div>'
            : '';

        var exclusions = policy.exclusions.length
            ? '<div class="stack-2"><span class="eyebrow">Key exclusions</span>' +
            policy.exclusions.map(function (e) {
                return '<div class="t-xs muted">' + FMT.esc(e) + '</div>';
            }).join('') + '</div>'
            : '';

        var askBtn = opts.ask
            ? btn({
                label: 'Ask about this plan', variant: 'soft', size: 'sm', icon: 'messageCircle',
                act: 'ask-ai', data: { q: 'Explain my ' + policy.name + ' policy in simple terms' }
            })
            : '';

        return '<div class="card card-hover">' +
            '<div class="policy-stripe"></div>' +
            '<div class="policy-head">' +
            '<span class="policy-icon">' + icon(policy.icon, 19) + '</span>' +
            '<div class="grow"><div class="policy-name">' + FMT.esc(policy.name) + '</div>' +
            '<div class="policy-type">' + FMT.esc(policy.category) + '</div></div>' +
            dotBadge(statusText, statusTone) +
            '</div>' +
            '<div class="policy-body">' +
            '<div class="figures">' +
            figure('Coverage', policy.coverText, true) +
            figure('Premium', FMT.money(policy.premium.amount) + ' ' + policy.premium.per) +
            (policy.ciSumAssured ? figure('Critical illness', FMT.money(policy.ciSumAssured)) : '') +
            figure('Term', policy.termText, true) +
            '</div>' +
            '<div class="stack-2">' + benefits + '</div>' +
            expand('Policy details', details + riders + exclusions, { icon: 'fileText' }) +
            (askBtn ? '<div class="card-actions">' + askBtn + '</div>' : '') +
            '</div></div>';
    }


    /* ======================================================================
       CUSTOMER CARD (used on the FR dashboard and customer list)
       ====================================================================== */
    function customerCard(c, opts) {
        opts = opts || {};
        var ratio = DATA.coverageRatio(c);
        var gap = DATA.coverageGap(c);
        var appt = DATA.nextApptFor(c.id);
        var riskTone = { Conservative: 'info', Moderate: 'warn', Balanced: 'info', Growth: 'brand' }[c.riskProfile] || 'info';

        return '<div class="card card-hover cust-card">' +

            '<div class="row top">' +
            avatar(c.name, 'lg', { seed: c.id }) +
            '<div class="grow stack-2" style="gap:2px">' +
            '<div class="row-2"><span class="card-title truncate">' + FMT.esc(c.name) + '</span>' +
            (c.priority === 'high' ? badge('Priority', 'bad') : '') + '</div>' +
            '<span class="t-xs muted truncate">' + FMT.esc(c.age + ' | ' + c.occupation) + '</span>' +
            '<span class="t-xs subtle truncate">' + FMT.esc(c.segment) + '</span>' +
            '</div></div>' +

            '<div class="chips">' + badge(c.riskProfile + ' risk', riskTone) +
            c.tags.slice(0, 2).map(function (t) { return badge(t); }).join('') + '</div>' +

            '<div class="stack-2">' +
            '<div class="meter-head"><span class="meter-label">Protection in place</span>' +
            '<span class="meter-val">' + ratio + '%</span></div>' +
            progress(ratio, { thin: true, tone: ratio >= 80 ? 'ok' : (ratio >= 55 ? '' : 'warn') }) +
            (gap > 0
                ? '<div class="t-xs t-warn semi">' + FMT.moneyShort(gap) + ' below the suggested cover</div>'
                : '<div class="t-xs t-ok semi">Meets the suggested cover</div>') +
            '</div>' +

            facts([
                ['Annual income', FMT.money(c.money.annualIncome)],
                ['Dependants', String(c.dependants)]
            ]) +

            '<div class="cust-card-foot">' +
            '<span class="t-xs muted row-2">' + icon(appt ? 'calendar' : 'clock', 13) +
            '<span class="truncate">' + FMT.esc(appt ? FMT.friendly(appt.start) : 'Last contact ' + FMT.relative(c.lastContact)) + '</span></span>' +
            '<span class="card-actions">' +
            btn({ label: 'PRUWise', variant: 'soft', size: 'xs', icon: 'sparkles', act: 'customer-navigator', data: { id: c.id } }) +
            btn({ label: 'Open', variant: 'outline', size: 'xs', iconRight: 'chevronRight', act: 'open-customer', data: { id: c.id } }) +
            '</span></div>' +

            '</div>';
    }


    /* ======================================================================
       APPOINTMENT CARD
       ====================================================================== */
    function apptCard(appt, opts) {
        opts = opts || {};
        var parts = FMT.dateParts(appt.start);
        var other = opts.view === 'customer' ? DATA.getRep(appt.repId) : DATA.getCustomer(appt.customerId);
        var isToday = FMT.friendly(appt.start).indexOf('Today') === 0;
        var modeIcon = { video: 'video', 'in-person': 'mapPin', phone: 'phone' }[appt.mode] || 'calendar';

        var agenda = (opts.agenda && appt.agenda.length)
            ? '<div class="stack-2" style="gap:4px"><span class="eyebrow">Agenda</span>' +
            appt.agenda.map(function (a) {
                return '<span class="tick">' + icon('check', 12) + '<span>' + FMT.esc(a) + '</span></span>';
            }).join('') + '</div>'
            : '';

        var actions = join([
            opts.join && appt.mode === 'video'
                ? btn({ label: opts.view === 'customer' ? 'Join call' : 'Start call', size: 'sm', icon: 'video', act: 'start-call', data: { id: appt.customerId } })
                : '',
            opts.reschedule
                ? btn({ label: 'Reschedule', variant: 'outline', size: 'sm', icon: 'calendar', act: 'reschedule', data: { id: appt.id } })
                : '',
            opts.prepare
                ? btn({ label: 'Prepare with AI', variant: 'soft', size: 'sm', icon: 'sparkles', act: 'customer-navigator', data: { id: appt.customerId } })
                : '',

            /* TALK TO THEM ABOUT IT.

               This replaced "Add to calendar", which was the wrong button to give
               the most prominent list on the screen. Exporting a meeting to Google
               Calendar is a once-per-booking administrative act; wanting to send a
               message to the person you are meeting is the thing that actually
               happens while looking at an appointment - "can we move this", "what
               should I bring", "I have uploaded the statement you asked for".

               The calendar export has NOT been deleted. /api/calendar still serves
               a subscribable feed, so a representative's whole diary syncs once
               instead of a button per meeting, which is the better shape for it
               anyway. The Calendar screen is where that lives.

               `consult` carries the OTHER person's id, so this works from either
               side: a representative lands in that customer's conversation, a
               customer lands in their representative's. */
            opts.consult && other
                ? btn({
                    /* Customer records carry firstName; representative records do
                       not, so fall back to the first word of the full name. */
                    label: opts.view === 'customer'
                        ? 'Message ' + (other.firstName || String(other.name).split(' ')[0])
                        : 'Consult',
                    variant: 'outline', size: 'sm', icon: 'messageCircle',
                    act: 'appt-consult', data: { id: other.id }
                })
                : '',

            opts.extraActions || ''
        ]);

        return '<div class="card card-hover"><div class="appt">' +
            '<div class="appt-date">' +
            '<span class="appt-month">' + parts.month + '</span>' +
            '<span class="appt-day">' + parts.day + '</span>' +
            '<span class="appt-month" style="opacity:.75">' + parts.weekday + '</span>' +
            '</div>' +
            '<div class="appt-main">' +
            '<div class="between" style="gap:8px">' +
            '<span class="appt-title">' + FMT.esc(appt.title) + '</span>' +
            (isToday ? badge('Today', 'solid') : '') +
            '</div>' +
            '<div class="appt-meta">' +
            '<span>' + icon('clock', 13) + FMT.time(appt.start) + ' | ' + appt.minutes + ' min</span>' +
            '<span>' + icon(modeIcon, 13) + FMT.esc(appt.type) + '</span>' +
            (other ? '<span class="truncate">' + icon('user', 13) + FMT.esc(other.name) + '</span>' : '') +
            '</div>' +
            '<div class="appt-meta"><span class="subtle">' + icon('mapPin', 13) + FMT.esc(appt.location) + '</span></div>' +
            agenda +
            (appt.preparedBy === 'PRUWise' ? '<div>' + aitag('AI prepared') + '</div>' : '') +
            (actions ? '<div class="card-actions" style="margin-top:4px">' + actions + '</div>' : '') +
            '</div></div></div>';
    }


    /* ======================================================================
       MINI MONTH CALENDAR

       A small month grid with a dot on any day that has an appointment. Built
       for the dashboard, which needs "what does my month look like" in the space
       of a card rather than a whole screen.

       miniCalendar({
           month:    a Date anywhere inside the month to draw
           marks:    { 'YYYY-MM-DD': 3 }  how many appointments that day
           selected: 'YYYY-MM-DD'         optional highlight
           dayHref:  '#/fr/calendar'      where a day click goes
       })

       LOCAL TIME, NEVER toISOString(). Converting to UTC first puts anything
       after early evening in Singapore on the wrong day, which is the single most
       common calendar bug there is. dayKey() below matches the one in
       js/pages-calendar.js exactly, so the two agree about what "today" means.
       ====================================================================== */

    var MINI_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    function miniDayKey(date) {
        var month = String(date.getMonth() + 1);
        var day = String(date.getDate());

        return date.getFullYear() + '-' +
            (month.length < 2 ? '0' + month : month) + '-' +
            (day.length < 2 ? '0' + day : day);
    }

    function miniCalendar(o) {
        o = o || {};

        var month = o.month || new Date();
        var marks = o.marks || {};
        var today = miniDayKey(new Date());

        var first = new Date(month.getFullYear(), month.getMonth(), 1);

        /* The Monday of the week the 1st falls in. getDay() gives 0 for Sunday
           and this grid starts on Monday, so Sunday counts as 6 or every row
           shifts by a week. */
        var lead = (first.getDay() + 6) % 7;
        var start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);

        /* Six weeks always. A fixed height stops the card growing and shrinking
           as the months change, which on a dashboard makes everything below it
           jump about. */
        var cells = '';

        for (var i = 0; i < 42; i++) {
            var day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            var key = miniDayKey(day);

            var outside = day.getMonth() !== month.getMonth();
            var count = Number(marks[key] || 0);

            var classes = 'mini-day' +
                (outside ? ' is-outside' : '') +
                (key === today ? ' is-today' : '') +
                (key === o.selected ? ' is-selected' : '') +
                (count ? ' has-appts' : '');

            /* An anchor when there is somewhere to go, a plain span otherwise -
               rather than a button that looks clickable and does nothing. */
            var label = day.getDate() +
                (count
                    ? '<span class="mini-dot" aria-hidden="true"></span>' +
                      '<span class="sr-only">' + count +
                      (count === 1 ? ' appointment' : ' appointments') + '</span>'
                    : '');

            cells += o.dayHref
                ? '<a class="' + classes + '" href="' + o.dayHref + '?day=' + key + '">' +
                  label + '</a>'
                : '<span class="' + classes + '">' + label + '</span>';
        }

        var weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(function (d, index) {
            return '<span class="mini-weekday"' +
                (index >= 5 ? ' style="opacity:.5"' : '') + '>' + d + '</span>';
        }).join('');

        return '<div class="mini-cal">' +
            '<div class="mini-head">' +
            '<span class="mini-month">' + MINI_MONTHS[month.getMonth()] + ' ' +
            month.getFullYear() + '</span>' +
            (o.actions || '') +
            '</div>' +
            '<div class="mini-grid mini-grid-head">' + weekdays + '</div>' +
            '<div class="mini-grid">' + cells + '</div>' +
            '</div>';
    }


    /* ======================================================================
       WORK QUEUE TILE

       Replaced the four "Active customers / Reviews completed / Recommendations
       accepted / Average gap closed" statistic cards on the representative's
       dashboard.

       WHY THOSE WENT. Three reasons, and the third is the one that matters.
       Their numbers were invented and did not match the database. "vs last
       quarter" implied a history the app has never recorded. And an
       ACCEPTANCE RATE at the top of the screen quietly tells a representative to
       optimise for people saying yes - which is the wrong incentive to put in
       front of somebody whose job here is to advise, in a product whose whole
       stated purpose is trust.

       A tile is a piece of WORK: a count, what it is, and somewhere to go and do
       it. Zero is a good state and says so, rather than showing a sad 0.
       ====================================================================== */
    function workTile(o) {
        o = o || {};

        var empty = !o.count;
        var body = empty
            ? '<span class="work-clear">' + icon('check', 13) + '<span>' +
              FMT.esc(o.clear || 'All clear') + '</span></span>'
            : '<span class="work-count">' + FMT.esc(String(o.count)) + '</span>' +
              '<span class="work-label">' + FMT.esc(o.label) + '</span>';

        var inner = '<span class="work-icon">' + icon(o.icon || 'inbox', 16) + '</span>' +
            '<span class="work-body">' +
            (empty ? '<span class="work-label">' + FMT.esc(o.label) + '</span>' : '') +
            body + '</span>' +
            (empty ? '' : icon('chevronRight', 15));

        var classes = 'work-tile' + (empty ? ' is-clear' : '') +
            (o.urgent && !empty ? ' is-urgent' : '');

        /* Nothing to do means nothing to click. A tile reading "All clear" that
           still navigates somewhere is a small lie about there being something
           there. */
        if (empty) {
            return '<div class="' + classes + '">' + inner + '</div>';
        }

        return o.href
            ? '<a class="' + classes + '" href="' + o.href + '">' + inner + '</a>'
            : '<button type="button" class="' + classes + '"' +
              dataAttrs(o.data) + (o.act ? ' data-act="' + o.act + '"' : '') +
              '>' + inner + '</button>';
    }


    /* ======================================================================
       TIMELINE
       ====================================================================== */
    function timeline(items, opts) {
        opts = opts || {};
        return '<div class="timeline">' + items.map(function (it) {
            return '<div class="tl">' +
                '<div class="tl-rail"><span class="tl-dot">' + icon(it.icon || 'activity', 14) + '</span>' +
                '<span class="tl-line"></span></div>' +
                '<div class="tl-body">' +
                '<div class="tl-title">' + FMT.esc(it.title) + '</div>' +
                (it.text ? '<div class="tl-text">' + FMT.esc(it.text) + '</div>' : '') +
                '<div class="row-2 wrap"><span class="tl-time">' + FMT.relative(it.time) + '</span>' +
                (opts.link && it.customerId
                    ? btn({ label: 'Open', variant: 'ghost', size: 'xs', iconRight: 'arrowRight', act: 'open-customer', data: { id: it.customerId } })
                    : '') +
                '</div></div></div>';
        }).join('') + '</div>';
    }


    /* ======================================================================
       CHAT MESSAGES
       A message is a plain object built by ai.js. It can contain paragraphs,
       bullet points, callouts, a glossary card, a recommendation card,
       action buttons, and suggested follow-up questions.
       ====================================================================== */
    function message(msg, opts) {
        opts = opts || {};

        // Grey centred system note
        if (msg.role === 'system') {
            return '<div class="msg msg-sys"><div class="msg-body">' +
                '<div class="msg-bubble">' + FMT.esc(msg.paragraphs.join(' ')) + '</div>' +
                '</div></div>';
        }

        var isMe = msg.role === 'me';

        /* ------------------------------------------------------------------
           A DELETED MESSAGE, WHICH IS STILL A MESSAGE

           It keeps its place in the conversation and says what happened. It is
           not removed from the list, because the other person read it and may
           have replied to it - a conversation where either side can silently
           make things they said stop having been said is not a record of
           anything. See the header of api/_routes/message.ts.

           The wording differs by side on purpose. "You deleted this" is a fact
           about something you chose to do; "This message was deleted" is all the
           other person can honestly be told, since the reason is not theirs to
           know. ------------------------------------------------------------ */
        if (msg.deleted) {
            return '<div class="msg ' + (isMe ? 'msg-me' : 'msg-ai') + '">' +
                '<div>' + (isMe
                    ? avatar(opts.userName || 'You', 'sm')
                    : (opts.themName
                        ? avatar(opts.themName, 'sm', { seed: opts.themSeed })
                        : '<span class="avatar avatar-sm">' + icon('sparkles', 15) + '</span>')) +
                '</div>' +
                '<div class="msg-body"><div class="msg-gone">' +
                icon('trash', 12) +
                '<span>' + (msg.deletedByMe
                    ? 'You deleted this message'
                    : 'This message was deleted') + '</span>' +
                '</div></div></div>';
        }

        /* Which avatar sits next to the message?
             your own message      -> your initials
             a person's message    -> their initials  (opts.themName is set)
             a PRUWise message     -> the sparkle icon */
        var av;
        if (isMe) {
            av = avatar(opts.userName || 'You', 'sm');
        } else if (opts.themName) {
            av = avatar(opts.themName, 'sm', { seed: opts.themSeed });
        } else {
            av = '<span class="avatar avatar-sm" title="PRUWise" aria-hidden="true">' +
                icon('sparkles', 15) + '</span>';
        }

        // --- bubble contents ---
        var bubble = '';

        /* Attachments come first, the way WhatsApp shows an image with its
           caption underneath. msg.files is an array of
           { name, size, type, url, isImage }. */
        (msg.files || []).forEach(function (f) {
            bubble += attachment(f);
        });

        (msg.paragraphs || []).forEach(function (p) {
            bubble += '<p>' + FMT.esc(p) + '</p>';
        });

        if (msg.bullets && msg.bullets.length) {
            bubble += '<ul>' + msg.bullets.filter(Boolean).map(function (b) {
                var saveBtn = '';
                if (b.saveable) {
                    var saved = (STATE.questions.indexOf(b.title) !== -1);
                    saveBtn = '<button type="button" class="btn btn-xs ' + (saved ? 'btn-soft' : 'btn-ghost') + '" ' +
                        'style="margin-top:8px" data-act="save-question" data-q="' + FMT.esc(b.title) + '">' +
                        icon(saved ? 'checkCircle' : 'bookmark', 13) +
                        '<span>' + (saved ? 'Saved to my questions' : 'Save this question') + '</span></button>';
                }
                return '<li><span>' +
                    (b.title ? '<strong>' + FMT.esc(b.title) + '</strong>' : '') +
                    (b.text ? FMT.esc(b.text) : '') + saveBtn +
                    '</span></li>';
            }).join('') + '</ul>';
        }

        var body = bubble ? '<div class="msg-bubble">' + bubble + '</div>' : '';

        // Little "Protection score: 62/100" pills
        if (msg.chips && msg.chips.length) {
            body += '<div class="chips">' + msg.chips.map(function (c) {
                return '<span class="badge badge-line"><span class="subtle">' + FMT.esc(c.label) + ':</span>&nbsp;' +
                    '<span class="bold">' + FMT.esc(c.value) + '</span></span>';
            }).join('') + '</div>';
        }

        (msg.callouts || []).forEach(function (c) { body += callout(c); });

        if (msg.term) { body += termCard(msg.term); }

        if (msg.recId) {
            var rec = DATA.recById(msg.recId);
            if (rec) {
                body += aiRecCard(rec, { compact: true, view: opts.view, showNeeds: opts.view === 'fr' });
            }
        }

        if (msg.disclaimer && !msg.recId) { body += disclaimer('short'); }

        if (msg.actions && msg.actions.length) {
            body += '<div class="card-actions">' + msg.actions.map(function (a) {
                return btn({
                    label: a.label, icon: a.icon, variant: 'outline', size: 'sm',
                    href: a.href, act: a.act, data: a.data
                });
            }).join('') + '</div>';
        }

        /* The footer line: who sent it, when, and a read receipt for messages
           you sent. opts.senderName lets a human conversation show a person's
           name instead of "PRUWise". */
        var who = isMe ? (opts.userName || 'You') : (opts.senderName || 'PRUWise');

        /* EDITED IS SAID PERMANENTLY, and that is what makes editing safe to allow
           with no time limit at all. The most useful correction is the one somebody
           makes on Thursday to a figure they mistyped on Monday; the thing that
           must not happen is the other person reading the new version believing it
           is what was originally sent. */
        var editedMark = msg.editedAt
            ? '<span>&middot;</span><span class="msg-edited" title="Edited ' +
              FMT.esc(FMT.friendly(msg.editedAt)) + '">edited</span>'
            : '';

        /* Edit and delete, on your own messages only.

           REAL BUTTONS WITH WORDS ON THEM, not a hover-only icon. The same lesson
           as the Refresh and Hide controls in the suggestion strip: a bare icon
           with no label does not read as an action, and a control that only exists
           on hover does not exist at all on a phone. They are small and quiet in
           the meta line, which is where somebody looks when they want to do
           something about a particular message.

           msg.canEdit comes from the server, which computes it from
           sender_account_id - so the buttons and the endpoint's answer come from
           one rule rather than two that can drift. The endpoint checks again
           regardless; a hidden button is a convenience, not a control. */
        var tools = (msg.canEdit && opts.editable)
            ? '<span class="msg-tools">' +
              '<button type="button" class="msg-tool" data-act="msg-edit" ' +
              'data-id="' + FMT.esc(msg.id) + '">' + icon('edit', 11) +
              '<span>Edit</span></button>' +
              '<button type="button" class="msg-tool is-bad" data-act="msg-delete" ' +
              'data-id="' + FMT.esc(msg.id) + '">' + icon('trash', 11) +
              '<span>Delete</span></button>' +
              '</span>'
            : '';

        /* READ ALOUD, on messages somebody else wrote.

           REQUESTED: "for the chat have a text to speech function for those who
           don't want to talk". Two different people want this and for different
           reasons - somebody who would rather listen than read a screen of
           insurance wording, and somebody reading on a phone on a bus.

           NOT ON YOUR OWN MESSAGES. Having your own sentence read back to you is
           not a feature, and the button would double the clutter in every meta
           line for nothing.

           The paragraphs only, deliberately: bullets, chips, action buttons and the
           disclaimer are all in this bubble too, and a voice that reads out
           "Ask PRUWise about this" as though it were part of the answer is worse
           than no voice. If the answer's substance is not in the paragraphs, the
           paragraphs are what should be fixed. */
        var readable = (msg.paragraphs || []).join(' ');

        var speakTool = (!isMe && readable)
            ? speakBtn(readable)
            : '';

        body += '<div class="msg-meta"><span>' + FMT.esc(who) + '</span>' +
            '<span>&middot;</span><span>' + FMT.time(msg.time) + '</span>' +
            editedMark +
            (isMe && msg.read ? '<span class="tick-read">' + icon('checkCheck', 13) + '</span>' : '') +
            speakTool +
            tools +
            '</div>';

        return '<div class="msg ' + (isMe ? 'msg-me' : 'msg-ai') +
            '" data-msg="' + FMT.esc(msg.id) + '">' +
            '<div>' + av + '</div><div class="msg-body">' + body + '</div></div>';
    }

    // The three bouncing dots
    function typing() {
        return '<div class="msg msg-ai" id="typing">' +
            '<div><span class="avatar avatar-sm">' + icon('sparkles', 15) + '</span></div>' +
            '<div class="msg-body"><div class="msg-bubble" style="padding:0">' +
            '<div class="typing"><span></span><span></span><span></span></div>' +
            '</div></div></div>';
    }

    function followups(list, label) {
        if (!list || !list.length) { return ''; }
        return '<div class="followups">' +
            '<div class="eyebrow">' + FMT.esc(label || 'Suggested follow-ups') + '</div>' +
            '<div class="followups-list">' + list.map(function (q) {
                return '<button type="button" class="prompt-chip" data-act="ask-ai" data-q="' + FMT.esc(q) + '">' +
                    icon('messageCircle', 13) + '<span>' + FMT.esc(q) + '</span></button>';
            }).join('') + '</div></div>';
    }

    // Glossary explanation card
    function termCard(term) {
        return '<div class="termcard">' +
            '<div class="row-2">' + icon('bookOpen', 15) + '<span class="eyebrow">In plain language</span></div>' +
            '<div class="h5">' + FMT.esc(term.term) + '</div>' +
            '<div class="t-sm semi">' + FMT.esc(term.short) + '</div>' +
            '<div class="t-sm muted">' + FMT.esc(term.plain) + '</div>' +
            (term.example
                ? '<div class="row-2 top" style="padding-top:8px;border-top:1px solid var(--brand-border)">' +
                icon('arrowRight', 13) + '<span class="t-xs muted">' + FMT.esc(term.example) + '</span></div>'
                : '') +
            '</div>';
    }


    /* ======================================================================
       AI RECOMMENDATION CARD
       The five blocks the brief asks for, always in the same order.
       ====================================================================== */
    function aiRecCard(rec, opts) {
        opts = opts || {};
        var showNeeds = opts.showNeeds !== false;
        var n = 0;   // running block number

        // One numbered block
        var block = function (title, iconName, inner) {
            n = n + 1;
            return '<div class="airec-block">' +
                '<div class="airec-block-title"><span class="airec-num">' + n + '</span>' +
                icon(iconName, 13) + '<span>' + title + '</span></div>' + inner + '</div>';
        };

        // One bullet inside a block
        var item = function (entry, iconName, warn) {
            return '<div class="airec-item' + (warn ? ' warn' : '') + '">' + icon(iconName, 15) +
                '<span>' + (entry.title ? '<strong>' + FMT.esc(entry.title) + '</strong>' : '') +
                FMT.esc(entry.text) +
                (opts.ask
                    ? '<button type="button" class="link t-xs" style="display:block;margin-top:4px" ' +
                    'data-act="ask-ai" data-q="Tell me more about: ' + FMT.esc(entry.title || entry.text) + '">Ask about this</button>'
                    : '') +
                '</span></div>';
        };

        var listOf = function (arr, iconName, warn) {
            return '<div class="stack-3">' + arr.map(function (e) { return item(e, iconName, warn); }).join('') + '</div>';
        };

        var body = join([
            block('Recommendation', 'sparkles',
                '<div class="stack-3"><div class="t-sm">' + FMT.esc(rec.recommendation) + '</div>' +
                facts([
                    ['Cover', rec.coverLabel],
                    ['Estimated premium', rec.premiumLabel],
                    ['Term', rec.term]
                ]) + '</div>'),

            block('Key reasons', 'target', listOf(rec.reasons, 'checkCircle')),

            showNeeds ? block('Relevant client needs', 'user', listOf(rec.needs, 'arrowRight')) : '',

            block('Important considerations', 'alertTriangle', listOf(rec.considerations, 'alertCircle', true)),

            block('Suggested next action', 'arrowUpRight',
                '<div class="airec-next">' + icon('zap', 15) + '<span>' + FMT.esc(rec.nextAction) + '</span></div>'),

            /* ------------------------------------------------------------------
               WHY THIS ONE AND NOT THE OTHERS

               Behind expanders, closed by default. The card was already long
               enough to scroll past, which was the complaint - so the detail is
               here for whoever wants it and folded away for whoever does not.

               EVERYTHING IN THESE THREE BLOCKS IS COMPUTED OR QUOTED, never
               written by the model. See DATA.recCompare().
               ------------------------------------------------------------------ */
            opts.compact ? '' : recWhyBlocks(rec, opts),

            disclaimer(opts.compact ? 'short' : 'long')
        ]);

        return '<div class="airec">' +

            '<div class="airec-top">' +
            '<div class="stack-2" style="min-width:0">' +
            '<div class="chips">' + aitag(opts.view === 'customer' ? 'Prepared for you' : 'AI recommendation') +
            (rec.product && rec.product.badge ? badge(rec.product.badge, 'line') : '') + '</div>' +
            '<div class="airec-title">' + FMT.esc(rec.product ? rec.product.name : 'Recommendation') + '</div>' +
            '<div class="t-sm muted">' + FMT.esc(rec.headline) + '</div>' +
            '</div>' +
            /* THE SCORE READS AS A PERCENTAGE NOW.

               It was a bare "92" in a ring labelled "Fit score", which is a number
               without a unit - it could have been out of 10, out of 100, or a
               rank. "92% match" needs no legend. */
            '<div class="row-2 no-shrink">' +
            '<span class="fit-ring" style="--fit:' + rec.fit + '" ' +
            'title="Matches ' + rec.fit + '% of what is on this client\'s record">' +
            '<span>' + rec.fit + '<i>%</i></span></span>' +
            '<span class="stack-2" style="gap:0"><span class="eyebrow">Match</span>' +
            '<span class="t-xs muted">against the record on file</span></span>' +
            '</div>' +
            '</div>' +

            '<div class="airec-body">' + body + '</div>' +

            (opts.actions ? '<div class="airec-foot"><div class="card-actions">' + opts.actions + '</div></div>' : '') +
            '</div>';
    }

    /* ======================================================================
       "WHY THIS ONE" - the three expanders under a recommendation

       Answers the two questions a customer actually asks: why this rather than
       the other options, and why this insurer.

       =======================================================================
       WHAT THESE BLOCKS WILL AND WILL NOT CLAIM
       =======================================================================

       HOW IT COMPARES is arithmetic over the other options on the same shortlist
       - cheaper or dearer, more or less cover, better or worse match. Every
       sentence is derived from numbers already on the screen.

       WHAT THIS PLAN DOES THAT THE OTHERS DO NOT is a set difference over the
       product catalogue's own feature lists. Also not an opinion.

       WHY THIS INSURER is the honest version of the question, and it is
       deliberately NOT "Prudential is better than the alternatives". This
       application holds one insurer's catalogue. It has never seen a competitor's
       policy wording, their exclusions or their pricing, so a claim that this plan
       beats theirs would be invented - and an invented comparison is exactly the
       thing a customer would be entitled to rely on and shouldn't. So the block
       states what THIS contract commits to, and says plainly that a like-for-like
       comparison needs the other document in front of a human.
       ====================================================================== */
    function recWhyBlocks(rec, opts) {
        var isCustomer = opts && opts.view === 'customer';
        var cmp = (typeof DATA !== 'undefined' && DATA.recCompare)
            ? DATA.recCompare(rec)
            : null;

        /* ---- how it compares to the rest of the shortlist ---- */
        var compare = '';

        if (cmp && cmp.lines.length) {
            compare = expand(
                isCustomer
                    ? 'Why this one and not the others'
                    : 'How this compares with the other options',

                '<div class="stack-3">' +
                cmp.lines.map(function (line) {
                    return '<div class="airec-item">' + icon('scale', 15) +
                        '<span>' + FMT.esc(line) + '</span></div>';
                }).join('') +
                (cmp.others.length
                    ? '<div class="t-xs subtle" style="padding-top:6px">Compared with ' +
                      FMT.esc(cmp.others.join(' and ')) + '.</div>'
                    : '') +
                '</div>',
                { icon: 'scale' });
        }

        /* ---- features the alternatives do not have ---- */
        var unique = '';

        if (cmp && cmp.onlyHere.length) {
            unique = expand('What this plan does that the others do not',
                '<div class="stack-2">' +
                cmp.onlyHere.map(function (f) {
                    return '<div class="airec-item">' + icon('checkCircle', 15) +
                        '<span>' + FMT.esc(f) + '</span></div>';
                }).join('') + '</div>',
                { icon: 'star' });
        }

        /* ---- why this insurer, answered honestly ---- */
        var product = rec.product || {};

        var whyInsurer = expand('Why this plan, and how to compare it elsewhere',
            '<div class="stack-3">' +

            '<div class="t-sm">' + FMT.esc(rec.whyFits) + '</div>' +

            (product.payout
                ? '<div class="airec-item">' + icon('creditCard', 15) +
                  '<span><strong>How it pays out: </strong>' + FMT.esc(product.payout) +
                  '</span></div>'
                : '') +

            ((product.features || []).length
                ? '<div class="stack-2">' +
                  '<span class="eyebrow">What this contract commits to</span>' +
                  product.features.map(function (f) {
                      return '<div class="airec-item">' + icon('check', 15) +
                          '<span>' + FMT.esc(f) + '</span></div>';
                  }).join('') + '</div>'
                : '') +

            (rec.benefits && rec.benefits.length
                ? facts(rec.benefits.map(function (b) { return [b.label, b.value]; }))
                : '') +

            /* THE HONEST LIMIT, stated on the card rather than left implied. */
            callout({
                tone: 'info', icon: 'info',
                title: 'Comparing this against another insurer',
                text: 'PRUWise only holds Prudential\u2019s own product terms, so it ' +
                    'cannot tell you this beats a specific plan from another company - ' +
                    'it has never seen their wording, exclusions or pricing. ' +
                    (isCustomer
                        ? 'Bring any quote you have to your representative and they can go through it line by line with you.'
                        : 'If the client brings a competitor illustration, that comparison is yours to make, not the assistant\u2019s.')
            }) +
            '</div>',
            { icon: 'helpCircle' });

        return compare + unique + whyInsurer;
    }


    // Short version used in lists and on dashboards
    function recSummaryCard(rec) {
        return '<div class="card card-pad card-hover stack-4">' +
            '<div class="between">' + aitag('Fit ' + rec.fit + '/100') +
            badge(rec.product.category, 'brand') + '</div>' +
            '<div class="card-title">' + FMT.esc(rec.product.name) + '</div>' +
            '<div class="t-sm muted clamp-3">' + FMT.esc(rec.headline) + '</div>' +
            facts([['Cover', rec.coverLabel], ['Premium', rec.premiumLabel]]) +
            btn({
                label: 'View full recommendation', variant: 'soft', size: 'sm', block: true,
                iconRight: 'arrowRight', href: '#/fr/recommendations?rec=' + rec.id
            }) +
            '</div>';
    }


    /* ======================================================================
       TALKING POINT + INSIGHT
       ====================================================================== */
    function talkpoint(o) {
        o = o || {};
        return '<button type="button" class="talkpoint' + (o.done ? ' done' : '') + '"' +
            (o.act ? ' data-act="' + o.act + '"' : '') + dataAttrs(o.data) + '>' +
            (o.check
                ? '<span class="talkpoint-check">' + icon('check', 11) + '</span>'
                : '<span class="num-badge">' + FMT.esc(o.num || '') + '</span>') +
            '<span class="talkpoint-text">' + FMT.esc(o.text) + '</span></button>';
    }

    function insight(o) {
        return '<div class="insight"><span class="insight-icon">' + icon(o.icon, 16) + '</span>' +
            '<div><div class="insight-title">' + FMT.esc(o.title) + '</div>' +
            '<div class="insight-text">' + FMT.esc(o.text) + '</div></div></div>';
    }


    /* ======================================================================
       STAR RATING
       stars(4.5)        read-only display, halves round to the nearest star
       starPicker(0)     clickable 1-5 picker (jQuery wires it in app.js)
       ====================================================================== */
    function stars(rating, size) {
        var filled = Math.round(Number(rating) || 0);
        var out = '';
        for (var i = 1; i <= 5; i++) {
            // A filled star is the solid shape; an empty one is just grey
            out += '<span class="' + (i <= filled ? '' : 'star-off') + '">' +
                starShape(size || 14, i <= filled) + '</span>';
        }
        return '<span class="stars" role="img" aria-label="' +
            (Math.round((Number(rating) || 0) * 10) / 10) + ' out of 5">' + out + '</span>';
    }

    // The star outline, optionally filled in
    function starShape(size, isFilled) {
        return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" ' +
            'fill="' + (isFilled ? 'currentColor' : 'none') + '" stroke="currentColor" ' +
            'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>' +
            '</svg>';
    }

    function starPicker(value) {
        var chosen = Number(value) || 0;
        var out = '';
        for (var i = 1; i <= 5; i++) {
            out += '<button type="button" class="' + (i <= chosen ? 'is-on' : '') + '" ' +
                'data-act="pick-star" data-value="' + i + '" ' +
                'aria-label="' + i + ' star' + (i > 1 ? 's' : '') + '">' +
                starShape(26, true) + '</button>';
        }
        return '<span class="star-pick" role="group" aria-label="Choose a rating">' + out + '</span>';
    }

    /* One row of a rating breakdown, e.g.  5 star |=========| 74% */
    function ratingBar(label, percent) {
        return '<div class="rating-bar-row"><span>' + FMT.esc(label) + '</span>' +
            progress(percent, { thin: true }) +
            '<span class="right num">' + Math.round(percent) + '%</span></div>';
    }

    /* ======================================================================
       POLICY RULE ROW
       Shows one eligibility rule and whether it passes.
       ====================================================================== */
    function rule(o) {
        return '<div class="rule ' + (o.pass ? 'pass' : 'fail') + '">' +
            '<span class="rule-icon">' + icon(o.pass ? 'check' : 'x', 12) + '</span>' +
            '<span><span class="rule-title">' + FMT.esc(o.title) + '</span><br>' +
            '<span class="muted">' + FMT.esc(o.text) + '</span></span></div>';
    }

    /* ======================================================================
       ATTACHMENTS

       A file object looks like:
         { name, size, type, url, isImage }

       `url` is made with URL.createObjectURL(file), which gives the browser a
       temporary local address for a file the user picked. Nothing is uploaded
       anywhere - this is a prototype, so the file only exists in this tab.
       ====================================================================== */
    function attachment(f) {
        if (f.isImage) {
            return '<img class="attach-image" src="' + f.url + '" alt="' + FMT.esc(f.name) + '" ' +
                'data-act="view-image" data-url="' + f.url + '" data-name="' + FMT.esc(f.name) + '">';
        }
        return '<a class="attach-file" href="' + f.url + '" download="' + FMT.esc(f.name) + '" ' +
            'title="Download ' + FMT.esc(f.name) + '">' +
            '<span class="attach-file-icon">' + icon('file', 17) + '</span>' +
            '<span style="min-width:0">' +
            '<span class="attach-file-name" style="display:block">' + FMT.esc(f.name) + '</span>' +
            '<span class="attach-file-meta">' + fileSize(f.size) + '</span></span>' +
            '</a>';
    }

    /* A chip for a file that has been picked but not sent yet.
       `index` lets the remove button say which one to drop. */
    function attachChip(f, index) {
        return '<span class="attach-chip">' +
            icon(f.isImage ? 'image' : 'file', 13) +
            '<span class="name">' + FMT.esc(f.name) + '</span>' +
            '<span class="size">' + fileSize(f.size) + '</span>' +
            '<button type="button" data-act="drop-attach" data-index="' + index + '" ' +
            'aria-label="Remove ' + FMT.esc(f.name) + '">' + icon('x', 12) + '</button>' +
            '</span>';
    }

    // 2048 -> "2 KB",  1500000 -> "1.4 MB"
    function fileSize(bytes) {
        var n = Number(bytes) || 0;
        if (n < 1024) { return n + ' B'; }
        if (n < 1024 * 1024) { return Math.round(n / 1024) + ' KB'; }
        return (Math.round((n / (1024 * 1024)) * 10) / 10) + ' MB';
    }

    /* ======================================================================
       AI SUGGESTED REPLIES

       Shown inside a HUMAN conversation. Clicking a suggestion only fills the
       input box - it never sends on its own, so a person always has the last
       word. That is deliberate: the AI assists, it does not speak for you.
       ====================================================================== */
    function suggestBox(o) {
        o = o || {};

        /* ------------------------------------------------------------------
           COLLAPSED. A single quiet button, not nothing.

           The old Hide button slid the box away and left no way back, so the
           only route to suggestions again was a page reload. Hiding something
           has to be reversible or it is deleting it. */
        if (o.collapsed) {
            return '<div class="suggest-collapsed" id="suggest-box">' +
                '<button type="button" class="suggest-show" data-act="show-suggest">' +
                icon('sparkles', 13) + '<span>Show suggested replies</span></button>' +
                '</div>';
        }

        if (!o.items || !o.items.length) { return ''; }

        /* Where the wording came from, said plainly.

           'openai' means a model wrote it from the conversation; anything else
           means the built-in rules did. Worth showing because the two read
           differently, and somebody about to send a message in their own name
           should know which they are looking at. */
        var badge = (o.source === 'openai')
            ? '<span class="suggest-src">' + icon('sparkles', 10) + ' AI</span>'
            : '<span class="suggest-src is-local">built-in</span>';

        /* REAL BUTTONS, NOT 10px TEXT LINKS.

           These were `class="link" style="font-size:10px"`, which rendered as two
           pieces of tiny grey text with no border, no background and no hover
           affordance. Nobody could tell they were clickable, which was reported as
           exactly that. They are now bordered, icon-led controls at a readable
           size with a hover and a focus state - see .suggest-btn in
           css/components.css. */
        return '<div class="suggest" id="suggest-box">' +
            '<div class="suggest-head">' +
            '<span>' + icon('sparkles', 12) + ' PRUWise suggested replies ' + badge + '</span>' +
            '<span class="suggest-actions">' +
            (o.loading
                ? '<span class="suggest-busy">' +
                  '<span class="spinner"></span>thinking' + FMT.esc('\u2026') + '</span>'

                /* DISABLED AND RELABELLED WHEN THERE IS NOTHING LEFT, rather than
                   left enabled to return the same three lines a fourth time. A
                   button that does nothing is worse than a button that says why -
                   this was reported as "it shows the same suggested reply". */
                : (o.exhausted
                    ? '<span class="suggest-busy" title="The built-in wording is a fallback, ' +
                      'not an endless supply">' + icon('info', 12) +
                      'that is all the built-in wording</span>'
                    : '<button type="button" class="suggest-btn" data-act="refresh-suggest" ' +
                      'title="Suggest again">' + icon('refresh', 12) +
                      '<span>Refresh</span></button>')) +
            '<button type="button" class="suggest-btn" data-act="hide-suggest" ' +
            'title="Hide these suggestions">' + icon('eyeOff', 12) +
            '<span>Hide</span></button>' +
            '</span>' +
            '</div>' +
            (o.note
                ? '<div class="suggest-note">' + icon('info', 12) + '<span>' + FMT.esc(o.note) + '</span></div>'
                : '') +
            '<div class="suggest-list">' + o.items.map(function (text) {
                return '<button type="button" class="suggest-item" data-act="use-suggestion" ' +
                    'data-text="' + FMT.esc(text) + '">' + icon('messageCircle', 13) +
                    '<span>' + FMT.esc(text) + '</span></button>';
            }).join('') + '</div>' +
            '<div class="suggest-note">' + icon('shield', 12) +
            '<span>Suggestions are drafts. Read them before sending, and adjust anything that is not right.</span></div>' +
            '</div>';
    }

    /* ======================================================================
       CONVERSATION LIST ROW (the Messages hub)
       ====================================================================== */
    function chatItem(o) {
        o = o || {};
        var avatarHtml = o.isAi
            ? '<span class="chat-avatar-ai">' + icon('sparkles', 20) + '</span>'
            : avatar(o.name, 'lg', { seed: o.seed, online: o.online });

        return '<button type="button" class="chat-item' + (o.active ? ' is-on' : '') + '" ' +
            'data-act="open-thread" data-id="' + o.id + '">' +
            avatarHtml +
            '<span class="chat-item-body">' +
            '<span class="chat-item-top">' +
            '<span class="chat-item-name">' + FMT.esc(o.name) + '</span>' +
            '<span class="chat-item-time">' + FMT.esc(o.time || '') + '</span>' +
            '</span>' +
            '<span class="chat-item-preview">' +
            (o.fromMe ? '<span class="tick-read">' + icon('checkCheck', 12) + '</span>' : '') +
            '<span>' + FMT.esc(o.preview || 'No messages yet') + '</span>' +
            (o.unread ? '<span class="unread-pill push">' + o.unread + '</span>' : '') +
            '</span></span></button>';
    }

    /* ======================================================================
       MODAL (pop-up dialog)

       UI.openModal({ title, sub, size, body, foot })
       Returns nothing; call UI.closeModal() to shut it, or the user can press
       Escape / click the dark background / press the X.
       ====================================================================== */
    function openModal(o) {
        o = o || {};
        closeModal();   // only ever one modal at a time

        var html = '<div class="modal-scrim" id="modal-scrim">' +
            '<div class="modal' + (o.size ? ' modal-' + o.size : '') + '" role="dialog" aria-modal="true" ' +
            'aria-label="' + FMT.esc(o.title || 'Dialog') + '">' +
            '<div class="modal-head"><div class="stack-2" style="gap:2px">' +
            '<div class="modal-title">' + FMT.esc(o.title) + '</div>' +
            (o.sub ? '<div class="modal-sub">' + FMT.esc(o.sub) + '</div>' : '') +
            '</div>' +
            '<button type="button" class="iconbtn iconbtn-sm" data-act="close-modal" aria-label="Close dialog">' +
            icon('x', 17) + '</button></div>' +
            '<div class="modal-body">' + (o.body || '') + '</div>' +
            (o.foot === null ? '' : '<div class="modal-foot">' +
                (o.foot || btn({ label: 'Close', variant: 'outline', act: 'close-modal' })) + '</div>') +
            '</div></div>';

        $('#modal-root').html(html);
        // Stop the page behind from scrolling while the modal is open
        $('body').css('overflow', 'hidden');
        animateBars();

        // Move keyboard focus into the dialog for accessibility
        $('#modal-scrim').find('input, select, textarea, button').not('[data-act="close-modal"]').first().trigger('focus');
    }

    function closeModal() {
        $('#modal-root').empty();
        $('body').css('overflow', '');
    }

    // Simple yes/no dialog
    function confirmModal(o) {
        openModal({
            title: o.title,
            size: 'sm',
            body: '<div class="t-sm muted">' + FMT.esc(o.message) + '</div>',
            foot: btn({ label: o.cancelLabel || 'Cancel', variant: 'ghost', act: 'close-modal' }) +
                btn({
                    label: o.confirmLabel || 'Confirm',
                    variant: o.tone || 'primary',
                    act: o.confirmAct,

                    /* Carried through to the confirm button as data attributes.

                       Without this, a handler for the confirm action has no way of
                       knowing WHICH row was being confirmed - the caller would have
                       to stash the id in a variable and hope nothing else
                       overwrote it before the click arrived. */
                    data: o.confirmData || null
                })
        });
    }


    /* ======================================================================
       WHAT PRUWISE LISTENS FOR

       ==================================================================
       WHY THIS PANEL EXISTS AT ALL
       ==================================================================

       It was asked for in as many words: "what are the type of question to ask so
       that the post-its will come out, and so the calendar function works." That is
       not a documentation gap, it is a product one. A feature that only fires on
       phrasings nobody can guess is, from the outside, a feature that does not
       work - and the person demonstrating it has no way to tell the two apart.

       ==================================================================
       IT IS BUILT FROM THE ACTUAL RULES, NOT WRITTEN SEPARATELY
       ==================================================================

       Every example below is a sentence that really does match a rule in
       api/_lib/insights.ts, and each row names what it produces. A help panel that
       drifts from the code it describes is worse than none, because it turns
       "I typed what it said" into a bug report about the wrong thing.

       It also says what does NOT trigger anything, which is the half people never
       get told: there is a relevance gate, small talk deliberately produces
       nothing, and roughly two sentences are needed before anything is read at all.

       A <details> element, so it is one line until somebody wants it. No JavaScript:
       the browser has done open-and-close since before this app existed.
       ====================================================================== */

    var LISTENS_FOR = [
        {
            group: 'Changes to their record',
            note: 'Proposed on their profile with the words that caused it. Nothing is ' +
                'written until the representative confirms it.',
            rows: [
                ['My salary is now ninety five thousand a year',
                    'proposes their annual income'],
                ['The mortgage went up, we are paying three thousand two hundred a month now',
                    'proposes their monthly commitments'],
                ['We just had a baby', 'flags a new dependant to add'],
                ['I got married last month', 'flags their marital status'],
                ['I started at a new job', 'flags a change of employer']
            ]
        },
        {
            group: 'A meeting',
            note: 'Read as a day and a time, so it can be booked in one click. Say a day ' +
                'or a time or both - with neither, there is nothing to put in a diary.',
            rows: [
                ['Could we book a meeting next Tuesday at 3pm',
                    'offers to book Tuesday, 3pm'],
                ['Can we speak tomorrow morning', 'offers to book tomorrow'],
                ['Shall we catch up next week', 'offers Monday next week']
            ]
        },
        {
            group: 'Things worth knowing',
            note: 'These go to the representative only, privately, and are phrased as a ' +
                'possibility rather than a conclusion.',
            rows: [
                ['Money is a bit tight at the moment', 'may be under financial pressure'],
                ['I do not understand what that means', 'slow down and check understanding'],
                ['I was diagnosed last month', 'health has come up'],
                ['My father passed away', 'a bereavement was mentioned']
            ]
        },
        {
            group: 'Loose ends',
            note: 'Anything promised or raised that somebody should come back to.',
            rows: [
                ['I will send you the figures this week', 'a follow-up to chase'],
                ['I need to make a claim', 'check whether a claim needs starting']
            ]
        }
    ];

    function listensFor(o) {
        o = o || {};

        var groups = LISTENS_FOR.map(function (g) {
            var rows = g.rows.map(function (r) {
                return '<li class="listen-row">' +
                    '<span class="listen-said">' + icon('messageCircle', 11) +
                    '<span>\u201C' + FMT.esc(r[0]) + '\u201D</span></span>' +
                    '<span class="listen-does">' + icon('arrowRight', 11) +
                    '<span>' + FMT.esc(r[1]) + '</span></span>' +
                    '</li>';
            }).join('');

            return '<div class="listen-group">' +
                '<div class="listen-title">' + FMT.esc(g.group) + '</div>' +
                '<div class="listen-note">' + FMT.esc(g.note) + '</div>' +
                '<ul class="listen-list">' + rows + '</ul>' +
                '</div>';
        }).join('');

        return '<details class="listens"' + (o.open ? ' open' : '') + '>' +
            '<summary class="listens-head">' +
            icon('helpCircle', 13) +
            '<span>' + FMT.esc(o.label || 'What PRUWise listens for') + '</span>' +
            icon('chevronDown', 13) +
            '</summary>' +

            '<div class="listens-body">' +
            groups +

            /* SAID LAST, AND IT IS THE PART THAT PREVENTS WASTED TIME. Somebody
               typing "hi" and waiting for a post-it needs to know that nothing is
               coming, and why. */
            '<div class="listen-limits">' +
            icon('info', 12) +
            '<span>Small talk produces nothing on purpose - the weather, the football ' +
            'and hello are all ignored. Roughly two sentences are needed before ' +
            'anything is read, and at least one of them has to touch money, cover, ' +
            'health, work, family or a meeting. Everything raised is a suggestion ' +
            'waiting on a person; none of it changes a record on its own.</span>' +
            '</div>' +
            '</div>' +
            '</details>';
    }


    /* ======================================================================
       TOAST (small confirmation message, bottom right)
       ====================================================================== */
    function toast(o) {
        o = o || {};
        var tone = o.tone || '';
        var iconName = { ok: 'checkCircle', warn: 'alertTriangle', bad: 'alertCircle', info: 'info' }[tone] || 'sparkles';

        var $t = $('<div class="toast ' + tone + '">' + icon(iconName, 17) +
            '<div class="stack-2" style="gap:1px">' +
            '<div class="toast-title">' + FMT.esc(o.title) + '</div>' +
            (o.message ? '<div class="toast-msg">' + FMT.esc(o.message) + '</div>' : '') +
            '</div>' +
            '<button type="button" class="iconbtn iconbtn-sm" data-act="close-toast" aria-label="Dismiss">' +
            icon('x', 14) + '</button></div>');

        $('#toast-root').append($t);

        // fadeOut then remove, after 3.6 seconds
        window.setTimeout(function () {
            $t.fadeOut(200, function () { $t.remove(); });
        }, o.duration || 3600);
    }


    /* ======================================================================
       DROPDOWN PANEL (notifications, profile menu, customer switcher)
       The trigger button must live inside an element with class .drop-anchor.
       ====================================================================== */
    /* Open a dropdown panel.

       ON A PHONE IT IS NOT PUT INSIDE THE BUTTON. It goes into #drop-root, which
       sits at the very bottom of the page next to #modal-root, and CSS pins it
       across the screen as a sheet.

       WHY THIS IS NECESSARY, because it looks like pointless indirection:

       .topbar has backdrop-filter for its frosted-glass effect. ANY value of
       backdrop-filter other than none makes an element a "containing block" for
       fixed-position descendants - which means a child with position:fixed is
       measured against the TOPBAR rather than against the screen. So a panel
       inside the topbar cannot be pinned to the viewport, no matter what you set
       left and right to. It also cannot escape an overflow:hidden anywhere up the
       chain.

       The only reliable answer is to not be in there. #drop-root has no
       transformed, filtered or clipping ancestor, so position:fixed means what it
       says. It is the same trick modals already use, which is why they have never
       had this problem.

       Safe to do because the click-anywhere-to-close handler in app.js tests
       `.drop, .drop-anchor` - it matches the panel itself, not only its old home.

       matchMedia uses the SAME breakpoint string as the CSS, so the two cannot
       drift apart and disagree about what counts as a phone. */
    function openDrop($anchor, html, opts) {
        opts = opts || {};
        closeDrops();

        var onPhone = window.matchMedia('(max-width: 639px)').matches;

        var markup = '<div class="drop' +
            (opts.wide ? ' drop-wide' : '') +
            (opts.left ? ' drop-left' : '') +
            (onPhone ? ' drop-sheet' : '') +
            '" role="dialog">' + html + '</div>';

        if (onPhone) { $('#drop-root').html(markup); }
        else { $anchor.append(markup); }
    }

    function closeDrops() {
        $('.drop').remove();
    }


    /* ======================================================================
       ANIMATE PROGRESS BARS
       Every bar is rendered at width 0 with a data-w="65" attribute.
       This function sets the real width one frame later, which makes the CSS
       transition run. Call it after inserting HTML that contains bars.
       ====================================================================== */
    function animateBars() {
        window.requestAnimationFrame(function () {
            $('[data-w]').each(function () {
                $(this).css('width', $(this).attr('data-w') + '%');
            });
        });
    }


    /* ======================================================================
       Everything below becomes available as UI.something
       ====================================================================== */
    return {
        icon: icon,
        logo: logo,
        logoFallback: logoFallback,
        pruwise: pruwise,

        stars: stars,
        starPicker: starPicker,
        ratingBar: ratingBar,
        rule: rule,

        attachment: attachment,
        attachChip: attachChip,
        fileSize: fileSize,
        suggestBox: suggestBox,
        listensFor: listensFor,
        chatItem: chatItem,

        btn: btn,
        iconBtn: iconBtn,
        chip: chip,
        badge: badge,
        warnDot: warnDot,

        /* Text to speech, entirely in the browser. See the long note above it. */
        speech: speech,
        speakBtn: speakBtn,
        dotBadge: dotBadge,
        aitag: aitag,

        avatar: avatar,
        person: person,

        card: card,
        secHead: secHead,
        pageHead: pageHead,
        stat: stat,

        fact: fact,
        facts: facts,
        kv: kv,
        figure: figure,
        callout: callout,
        disclaimer: disclaimer,
        expand: expand,
        progress: progress,
        meter: meter,
        coverageBars: coverageBars,
        coverageLineBars: coverageLineBars,

        emptyState: emptyState,
        errorState: errorState,
        loadingState: loadingState,
        skeletonCard: skeletonCard,
        skeletonGrid: skeletonGrid,

        table: table,
        statusCell: statusCell,

        tabs: tabs,
        switchTab: switchTab,

        policyCard: policyCard,
        customerCard: customerCard,
        apptCard: apptCard,
        miniCalendar: miniCalendar,
        miniDayKey: miniDayKey,
        workTile: workTile,
        timeline: timeline,

        message: message,
        typing: typing,
        followups: followups,
        termCard: termCard,

        aiRecCard: aiRecCard,
        recSummaryCard: recSummaryCard,
        talkpoint: talkpoint,
        insight: insight,

        openModal: openModal,
        closeModal: closeModal,
        confirmModal: confirmModal,
        toast: toast,

        openDrop: openDrop,
        closeDrops: closeDrops,

        animateBars: animateBars,
        join: join
    };

})();
