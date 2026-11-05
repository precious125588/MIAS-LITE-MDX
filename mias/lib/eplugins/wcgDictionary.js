/**
 * Levanter's word-check dictionary (lib/class/Wcg.js and lib/wcg.js `exist`).
 * Copyright (c) lyfe00011, MIT License (see LICENSE-LEVANTER.txt).
 *
 * word.txt is a compressed word graph (a DAWG) in the format Levanter downloads from
 * https://gist.githubusercontent.com/lyfe00011/dc86b4db7c6eafe5a57c3390adb26dfb/raw/word.txt.
 * The comparisons and pruning below follow Levanter's Wcg.js line for line; only the names are readable.
 */
import fs from "node:fs";
import path from "node:path";

export const WCG_WORD_URL = "https://gist.githubusercontent.com/lyfe00011/dc86b4db7c6eafe5a57c3390adb26dfb/raw/word.txt";

const BASE = 36;
const NODE_SEP = ";";
const END = ",";
const TERMINAL = "!";
const UPPER_EMPTY = "z".repeat(9); // Levanter: new Array(10).join("z")
const EDGE = /([a-z]+)(,|[0-9A-Z]+|$)/g;
const SYMBOL = /([0-9A-Z]+):([0-9A-Z]+)/;

// Levanter: a base-36 number with a bijective offset (lengths 1..n-1 come first).
function decodeNumber(text) {
  let value = 0;
  for (let n = 1, step = BASE; n < text.length; n++, step *= BASE) value += step;
  for (let i = text.length - 1, mult = 1; i >= 0; i--, mult *= BASE) {
    let digit = text.charCodeAt(i) - 48;
    if (digit > 10) digit -= 7;
    value += digit * mult;
  }
  return value;
}

// Levanter: the upper bound for completions of a prefix (last character + 1).
function upperBound(prefix) {
  if (prefix.length === 0) return UPPER_EMPTY;
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

export class WordGraph {
  constructor(text) {
    this.syms = [];
    this.symCount = 0;
    this.nodes = String(text).split(NODE_SEP);
    while (true) {
      const m = SYMBOL.exec(this.nodes[this.symCount]);
      if (!m) break;
      if (decodeNumber(m[1]) !== this.symCount) {
        throw new Error(`Invalid Symbol name - found ${m[1]} when expecting ${this.symCount}`);
      }
      this.syms[this.symCount] = decodeNumber(m[2]);
      this.symCount++;
    }
    this.nodes.splice(0, this.symCount);
  }

  isWord(word) {
    if (word === "") return false;
    return this.match(word) === word;
  }

  // The longest dictionary word that is a prefix of `word`, or "".
  match(word) {
    const found = this.matches(word);
    return found.length === 0 ? "" : found[found.length - 1];
  }

  matches(prefix) {
    return this.words(prefix, prefix + "a");
  }

  // Words w with from <= w < beyond. When beyond is from + "a", the prefix form is used.
  words(from, beyond) {
    const out = [];
    const state = {
      from,
      beyond,
      prefixes: from + "a" === beyond,
      fn: (w) => out.push(w),
    };
    this.enumerate(0, "", state);
    return out;
  }

  enumerate(nodeIndex, prefix, state) {
    let node = this.nodes[nodeIndex];
    const emit = (word) => {
      if (state.prefixes) {
        if (state.from.slice(0, word.length) === word) state.fn(word);
        return;
      }
      if (state.from <= word && word < state.beyond) state.fn(word);
    };
    if (node[0] === TERMINAL) {
      emit(prefix);
      node = node.slice(1);
    }
    node.replace(EDGE, (_match, label, ref) => {
      const next = prefix + label;
      if (next >= state.beyond || next < state.from.slice(0, next.length)) return "";
      if (ref === END || ref === "") {
        emit(next);
        return "";
      }
      this.enumerate(this.inodeFromRef(ref, nodeIndex), next, state);
      return "";
    });
  }

  inodeFromRef(ref, currentIndex) {
    let n = decodeNumber(ref);
    if (n < this.symCount) return this.syms[n];
    n -= this.symCount;
    return currentIndex + n + 1;
  }
}

/**
 * Lazy word list, as Levanter's wcg.exist: the file is read from disk, or downloaded once
 * when it is missing. exist() is synchronous, so it returns false until the list has loaded.
 */
export function createWordChecker({ file, url = WCG_WORD_URL, httpGet }) {
  let graph = null;
  let loading = null;

  async function load() {
    if (graph) return graph;
    if (!loading) {
      loading = (async () => {
        let text;
        if (fs.existsSync(file)) {
          text = fs.readFileSync(file, "utf8");
        } else {
          if (typeof httpGet !== "function") throw new Error("failed to download word.txt");
          const res = await httpGet(url, { responseType: "arraybuffer", timeout: 60000 });
          text = Buffer.from(res.data).toString("utf8");
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, text);
        }
        graph = new WordGraph(text);
        return graph;
      })();
      loading.catch(() => { loading = null; });
    }
    return loading;
  }

  return {
    load,
    exist(word) {
      if (!graph) {
        load().catch((e) => console.error("[eplugin] wcg dictionary:", e.message));
        return false;
      }
      return graph.isWord(String(word).toLowerCase());
    },
  };
}
