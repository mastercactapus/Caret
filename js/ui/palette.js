define([
    "sessions",
    "command",
    "editor",
    "settings!menus,user",
    "ui/statusbar",
    "ui/projectManager",
    "util/template!templates/paletteItem.html",
    "util/dom2"
  ], function(sessions, command, editor, Settings, status, project, inflate) {
  
  var TokenIterator = ace.require("ace/token_iterator").TokenIterator;
  var refTest = /identifier|variable|function/;
  var jsRefTest = /entity\.name\.function/;
  
  //build a regex that finds special regex characters for sanitization
  var antiregex = new RegExp("(\\\\|\\" + "?.*+[](){}|^$".split("").join("|\\") + ")", "g");
  var sanitize = function(text) {
    //turn HTML into escaped text for presentation
    return text.replace(/\</g, "&lt;").replace(/\>/g, "&gt;").trim();
  };
  
  var re = {
    file: /^([^:#@]*)/,
    line: /:(\d*)/,
    reference: /@([^:#]*)/,
    search: /#([^:@]*)/
  };
  
  var prefixes = {
    ":": "line",
    "@": "reference",
    "#": "search"
  };
  
  var modes = {
    "line": ":",
    "search": "#",
    "reference": "@"
  };
  
  var DEBOUNCE = 50;
  
  var Palette = function() {
    this.homeTab = null;
    this.results = [];
    this.cache = {};
    this.allFiles = [];
    this.files = [];
    this.pending = null;
    this.selected = 0;
    this.element = document.find(".palette");
    this.input = this.element.find("input");
    this.resultList = this.element.find(".results");
    this.commandMode = false;
    this.searchAll = false;
    this.bindInput();
  };
  Palette.prototype = {
    bindInput: function() {
      var input = this.input;
      var self = this;
      
      input.on("blur", function() {
        self.deactivate();
      });
      
      input.on("keydown", function(e) {
        //escape
        if (e.keyCode == 27) {
          sessions.restoreLocation();
          editor.clearSelection();
          return input.blur();
        }
        //enter
        if (e.keyCode == 13) {
          e.stopImmediatePropagation();
          e.preventDefault();
          self.executeCurrent();
          return;
        }
        //up/down
        if (e.keyCode == 38 || e.keyCode == 40) {
          e.preventDefault();
          e.stopImmediatePropagation();
          self.navigateList(e.keyCode == 38 ? -1 : 1);
          self.render();
          return;
        }
        //backspace -- falls through
        if (e.keyCode == 8) {
          //clear search progress cache
          self.files = self.allFiles;
        }
        self.selected = 0;
      });
      
      input.on("keyup", function(e) {
        if (self.pending) {
          return;
        }
        self.pending = setTimeout(function() {
          self.pending = null;
          self.parse(input.value);
        }, DEBOUNCE);
      });
    },
    
    parse: function(query) {
      var startsWith = query[0];
      if (startsWith in prefixes) {
        this.commandMode = false;
      }
      if (this.commandMode) {
        this.findCommands(query);
      } else {
        this.findLocations(query);
      }
      this.render();
    },
    
    findCommands: function(query) {
      if (query.length == 0) return this.results = [];
      var fuzzyCommand = new RegExp(query
        .split("")
        .map(function(char) { return char.replace(antiregex, "\\$1")})
        .join(".*?"),
      "i");
      var results = [];
      //load matches from the menu
      var menus = Settings.get("menus");
      var menuWalker = function(menu) {
        for (var i = 0; i < menu.length; i++) {
          var item = menu[i];
          //skip dividers and other special cases
          if (typeof item == "string") continue;
          if (item.minVersion && item.minVersion > window.navigator.version) continue;
          if (item.command && fuzzyCommand.test(item.palette || item.label)) {
            results.push(item);
          }
          if (item.sub) {
            menuWalker(item.sub);
          }
        }
      };
      menuWalker(menus);
      //also load from the command list
      var uniques = {};
      //do not duplicate results from menu
      results.forEach(function(r) { uniques[r.command] = true; });
      for (var i = 0; i < command.list.length; i++) {
        var c = command.list[i];
        if (c.command in uniques) continue;
        if (fuzzyCommand.test(c.label)) {
          results.push(c);
        }
      }
      //sort the results into best-match
      results.sort(function(a, b) {
        var aMatch = fuzzyCommand.exec(a.palette || a.label);
        var bMatch = fuzzyCommand.exec(b.palette || b.label);
        var aScore = aMatch.index + aMatch[0].length;
        var bScore = bMatch.index + bMatch[0].length;
        if (aScore == bScore) return ((a.palette || a.label) < (b.palette || b.label) ? -1 : 1);
        return aScore - bScore;
      });
      this.results = results.slice(0, 10);
    },
    
    getTabValues: function(tab) {
      var name = tab.fileName;
      if (!this.cache[name]) {
        return this.cacheTab(tab);
      }
      var cache = this.cache[name];
      for (var i = 0; i < cache.length; i++) {
        if (cache[i].tab == tab) {
          return cache[i];
        }
      }
      return this.cacheTab(tab);
    },
    
    cacheTab: function(tab) {
      //create cache entry
      var entry = {
        tab: tab,
        refs: [],
        text: tab.getValue()
      };
      //create token iterator, search for all references
      var ti = new TokenIterator(tab, 0);
      var token;
      while (token = ti.stepForward()) {
        if (tab.syntaxMode == "javascript" ? jsRefTest.test(token.type) : refTest.test(token.type)) {
          //this is a match, let's store it as a valid result object
          var row = ti.getCurrentTokenRow();
          var col = ti.getCurrentTokenColumn();
          var line = sanitize(tab.getLine(row));
          entry.refs.push({
            tab: tab,
            line: row,
            value: token.value,
            label: tab.fileName + ":" + row,
            sublabel: line,
            column: col
          });
        }
      }
      var name = tab.fileName;
      if (!this.cache[name]) {
        this.cache[name] = [ entry ];
      } else {
        this.cache[name].push(entry);
      }
      return entry;
    },
    
    //note: this function is WAY TOO LONG
    findLocations: function(query) {
      var file = re.file.test(query) && re.file.exec(query)[1];
      var line = re.line.test(query) && Number(re.line.exec(query)[1]) - 1;
      var search = re.search.test(query) && re.search.exec(query)[1];
      var reference = re.reference.test(query) && re.reference.exec(query)[1];
      var results = [];
      var self = this;
      
      var tabs, projectFiles = [];
      
      if (file) {
        //search through open files by name
        var fuzzyFile = new RegExp(file
          .replace(/ /g, "")
          .split("")
          .map(function(char) { return char.replace(antiregex, "\\$1") })
          .join(".*?"),
        "i");
        tabs = sessions.getAllTabs().filter(function(tab) {
          return fuzzyFile.test(tab.fileName);
        });
        //check the project for matches as well
        this.files = this.files.filter(function(path) { return fuzzyFile.test(path) });
        
        //sort files by relevance
        this.files.sort(function(a, b) {
          //first check the filename for each
          var aFile = a.split(/[\/\\]/).pop();
          var bFile = b.split(/[\/\\]/).pop();
          var aMatch = fuzzyFile.exec(aFile);
          var bMatch = fuzzyFile.exec(bFile);
          //if either file matches...
          if (aMatch || bMatch) {
            //and if one doesn't, the match wins
            if (!aMatch) {
              return 1;
            } else if (!bMatch) {
              return -1
            } else {
              var aScore = aMatch.pop().length + aMatch.index;
              var bScore = bMatch.pop().length + bMatch.index;
              var comparison = aScore - bScore;
              //identical scores? sort on path
              if (comparison == 0) {
                return a < b ? -1 : 1;
              }
              return comparison;
            }
          }
          //otherwise, sort shorter full-path match sequences higher
          var aResult = fuzzyFile.exec(a).pop();
          var bResult = fuzzyFile.exec(b).pop();
          var len = aResult.length - bResult.length;
          //identical lengths, sort on path
          if (len == 0) {
            return a < b ? -1 : 1;
          }
          return len;
        });
        
        //transform into result objects
        projectFiles = this.files.map(function(path) {
          return {
              label: path.substr(path.search(/[^\/\\]+$/)),
              sublabel: path,
              command: "project:open-file",
              argument: path
          };
        });
      } else {
        //the search domain is the current tab
        var current = this.homeTab;
        tabs = [ current ];
        if (this.searchAll) {
          tabs.push.apply(tabs, sessions.getAllTabs().filter(function(t) { return t !== current }));
        }
      }
      
      tabs = tabs.map(function(t) {
        return {
          tab: t,
          line: line
        };
      });
      
      if (search) {
        //find text in open tab(s)
        try {
          var crawl = new RegExp(search.replace(antiregex, "\\$1"), "gi");
        } catch (e) {
          return;
        }
        var results = [];
        tabs.forEach(function(t) {
          if (results.length >= 10) return;
          var found;
          var lines = [];
          var text = self.getTabValues(t.tab).text;
          while (found = crawl.exec(text)) {
            var position = t.tab.doc.indexToPosition(found.index);
            if (lines.indexOf(position.row) > -1) {
              continue;
            }
            lines.push(position.row);
            var result = {
              tab: t.tab
            };
            result.label = result.tab.fileName;
            result.sublabel = sanitize(result.tab.getLine(position.row));
            result.line = position.row;
            results.push(result);
            if (results.length >= 10) return;
          }
        });
        tabs = results;
      } else if (reference !== false) {
        //search by symbol reference
        try {
          var crawl = new RegExp(reference.replace(antiregex, "\\$1"), "i");
        } catch (e) {
          return;
        }
        var results = [];
        tabs.forEach(function(t) {
          if (results.length >= 10) return;
          var refs = self.getTabValues(t.tab).refs;
          for (var i = 0; i < refs.length; i++) {
            if (crawl.test(refs[i].value)) {
              var len = results.push(refs[i]);
              if (len >= 10) return;
            }
          }
        });
        tabs = results;
      }
      
      this.results = tabs.concat(projectFiles).slice(0, 10);
      
      if (this.results.length) {
        var current = this.results[this.selected];
        if (!current.tab) return;
        sessions.raiseBlurred(current.tab);
        if (current.line) {
          editor.clearSelection();
          editor.moveCursorTo(current.line, current.column || 0);
          if (current.column) {
            editor.execCommand("selectwordright");
          }
        }
      }
    },
    
    executeCurrent: function() {
      var current = this.results[this.selected];
      if (!current) return;
      if (current.command) {
        status.toast("Executing: " + current.label + "...");
        command.fire(current.command, current.argument);
      } else {
        //must be the file search
        command.fire("session:check-file");
      }
      this.deactivate();
      if (!current.retainFocus) editor.focus();
    },
    
    activate: function(mode) {
      this.homeTab = sessions.getCurrent();
      this.results = [];
      this.cache = {};
      this.allFiles = this.files = project.getPaths();
      this.pending = null;
      this.selected = 0;
      this.searchAll = Settings.get("user").searchAllFiles;
      this.commandMode = mode == "command";
      this.input.value = modes[mode] || "";
      this.render();
      this.element.addClass("active");
      this.input.focus();
    },
    
    deactivate: function() {
      this.element.removeClass("active");
      if (this.pending) clearTimeout(this.pending);
    },
    
    navigateList: function(interval) {
      this.selected = (this.selected + interval) % this.results.length;
      if (this.selected < 0) {
        this.selected = this.results.length + this.selected;
      }
      var current = this.results[this.selected];
      if (current && current.tab) {
        sessions.raiseBlurred(current.tab);
      }
      this.render();
    },
    
    render: function() {
      var self = this;
      this.element.find(".mode").innerHTML = this.commandMode ? "Command:" : "Go To:";
      this.resultList.innerHTML = "";
      this.results.slice(0, 10).forEach(function(r, i) {
        var element = inflate.get("templates/paletteItem.html", {
          label: r.palette || r.label || (r.tab ? r.tab.fileName : ""),
          sublabel: r.sublabel,
          isCurrent: i == self.selected
        });
        self.resultList.append(element);
      });
    }
  };
  
  var palette = new Palette();
  
  command.on("palette:open", function(mode) {
    sessions.saveLocation();
    palette.activate(mode);
  });
  
  return palette;
  
});