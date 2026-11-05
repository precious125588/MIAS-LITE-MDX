// .ruchi / .kima: the owner grants a person access to single commands, in that person's DM only.
//   .ruchi <command>  grants it     (run in the person's DM)
//   .kima <command>   removes it    (run in the same DM; .kima all removes every grant)
// Grants live in database/cmd_grants.json as { "<digits>": ["ping", ...] }. Groups never qualify.

import fs from "fs";
import path from "path";

export function createCmdGrantStore({ file, warn = console.warn }) {
  const data = load();

  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const out = {};
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [num, list] of Object.entries(raw)) {
          const digits = String(num).replace(/[^0-9]/g, "");
          const clean = [...new Set((Array.isArray(list) ? list : []).map((c) => String(c).toLowerCase()).filter(Boolean))];
          if (digits && clean.length) out[digits] = clean;
        }
      }
      return out;
    } catch (error) {
      if (error?.code !== "ENOENT") warn(`[cmd-grants] could not read ${file}: ${error.message}`);
      return {};
    }
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
      return true;
    } catch (error) {
      warn(`[cmd-grants] save failed: ${error.message}`);
      return false;
    }
  }

  return {
    file,
    has(num, cmd) {
      return !!num && !!cmd && (data[num] || []).includes(String(cmd).toLowerCase());
    },
    list(num) {
      return [...(data[num] || [])];
    },
    /** @returns {"added"|"exists"|"error"} */
    grant(num, cmd) {
      const c = String(cmd).toLowerCase();
      const current = data[num] || [];
      if (current.includes(c)) return "exists";
      data[num] = [...current, c];
      if (save()) return "added";
      if (current.length) data[num] = current; else delete data[num];
      return "error";
    },
    revoke(num, cmd) {
      const c = String(cmd).toLowerCase();
      const current = data[num] || [];
      if (!current.includes(c)) return false;
      const next = current.filter((x) => x !== c);
      if (next.length) data[num] = next; else delete data[num];
      save();
      return true;
    },
    revokeAll(num) {
      const count = (data[num] || []).length;
      if (!count) return 0;
      delete data[num];
      save();
      return count;
    },
  };
}

export function installCmdGrantCommands(ctx) {
  const { cmd, store, sendReply, isGroup, numOf, resolveTarget, prefix } = ctx;
  const p = () => prefix();

  cmd(["ruchi"], { desc: "Grant a command to this person in their DM — .ruchi <command>", category: "OWNER", ownerOnly: true }, async (sock, msg, args) => {
    if (isGroup(msg)) return sendReply(sock, msg, `👥 Use *${p()}ruchi* in the person's DM, not in a group.`);
    const jid = msg.key.remoteJid;
    const num = numOf(jid);
    const want = String(args[0] || "").trim();
    if (!num) return sendReply(sock, msg, "❌ Couldn't read this person's number.");
    if (!want) {
      const mine = store.list(num);
      return sendReply(sock, msg, `Usage: *${p()}ruchi <command>*\nExample: *${p()}ruchi ping*\n\nGranted here: ${mine.length ? mine.join(", ") : "none"}`);
    }
    const target = resolveTarget(want);
    if (!target) return sendReply(sock, msg, `❌ There's no command called *${want}*.`);
    if (!target.grantable) return sendReply(sock, msg, `🚫 *${target.name}* can't be granted to anyone.`);
    const result = store.grant(num, target.name);
    if (result === "error") return sendReply(sock, msg, "❌ Couldn't save the grant. Try again.");
    if (result === "exists") return sendReply(sock, msg, `ℹ️ @${num} already has access to *${target.name}*.`, [jid]);
    return sendReply(
      sock, msg,
      `✅ @${num} has been granted access to *${target.name}*.\n\n• Remove it with *${p()}kima ${target.name}*\n• Grant another with *${p()}ruchi <command>*`,
      [jid],
    );
  });

  cmd(["kima"], { desc: "Remove a command grant from this person in their DM — .kima <command> | .kima all", category: "OWNER", ownerOnly: true }, async (sock, msg, args) => {
    if (isGroup(msg)) return sendReply(sock, msg, `👥 Use *${p()}kima* in the person's DM, not in a group.`);
    const jid = msg.key.remoteJid;
    const num = numOf(jid);
    const want = String(args[0] || "").trim().toLowerCase();
    if (!num) return sendReply(sock, msg, "❌ Couldn't read this person's number.");
    if (!want) {
      const mine = store.list(num);
      return sendReply(sock, msg, `Usage: *${p()}kima <command>* or *${p()}kima all*\n\nGranted here: ${mine.length ? mine.join(", ") : "none"}`);
    }
    if (want === "all") {
      const removed = store.revokeAll(num);
      if (!removed) return sendReply(sock, msg, `ℹ️ @${num} has no granted commands.`, [jid]);
      return sendReply(sock, msg, `🗑️ Removed all ${removed} granted command(s) from @${num}.`, [jid]);
    }
    const target = resolveTarget(want);
    const name = target ? target.name : want;
    if (store.revoke(num, name)) return sendReply(sock, msg, `🗑️ Removed access to *${name}* from @${num}.`, [jid]);
    return sendReply(sock, msg, `ℹ️ @${num} doesn't have access to *${name}*.`, [jid]);
  });
}
