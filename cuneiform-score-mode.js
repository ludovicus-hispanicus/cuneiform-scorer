ace.define("ace/mode/cuneiform_score_highlight_rules", ["require", "exports", "module", "ace/lib/oop", "ace/mode/text_highlight_rules"], function (require, exports, module) {
    "use strict";

    var oop = require("../lib/oop");
    var TextHighlightRules = require("./text_highlight_rules").TextHighlightRules;

    var CuneiformScoreHighlightRules = function () {
        this.$rules = {
            "start": [
                {
                    token: "meta.tag", // @obverse, @reverse, @column 1
                    regex: /^@(?:obverse|reverse|edge|left edge|right edge|top|bottom|colophon|column(?:\s+\d+)?)/,
                    caseInsensitive: true
                },
                {
                    token: "string", // #note: (green)
                    regex: /^#note:.*$/
                },
                {
                    token: "comment", // $ single ruling, $ rest of tablet blank
                    regex: /^\$.*$/
                },
                {
                    token: "string", // // F K.3547... (Parallels) - using string color (often green/red) to distinguish from comment
                    regex: /^\/\/.*$/
                },
                {
                    token: "keyword", // section marker § 1
                    regex: /^§\s*\d+/
                },
                {
                    token: "constant.numeric", // 1. or 1'. at start of line
                    regex: /^\s*\d+'?\.?/
                },
                {
                    token: "constant.language", // ($___$)
                    regex: /\(\$___\$\)/
                }
            ]
        };
    };

    oop.inherits(CuneiformScoreHighlightRules, TextHighlightRules);

    exports.CuneiformScoreHighlightRules = CuneiformScoreHighlightRules;
});

ace.define("ace/mode/cuneiform_score", ["require", "exports", "module", "ace/lib/oop", "ace/mode/text", "ace/mode/cuneiform_score_highlight_rules"], function (require, exports, module) {
    "use strict";

    var oop = require("../lib/oop");
    var TextMode = require("./text").Mode;
    var CuneiformScoreHighlightRules = require("./cuneiform_score_highlight_rules").CuneiformScoreHighlightRules;

    var Mode = function () {
        this.HighlightRules = CuneiformScoreHighlightRules;
    };
    oop.inherits(Mode, TextMode);

    (function () {
        // Extra logic if needed
    }).call(Mode.prototype);

    exports.Mode = Mode;
});
