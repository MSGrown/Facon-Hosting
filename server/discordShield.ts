import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHIELD_BASE_DIR = path.resolve(process.cwd(), '.facon_runtime', 'shield');
const NODE_SHIELD_DIR = path.join(SHIELD_BASE_DIR, 'node');
const PYTHON_SHIELD_DIR = path.join(SHIELD_BASE_DIR, 'python');

const NODE_SHIELD_FILE = path.join(NODE_SHIELD_DIR, 'facon_discord_shield.mjs');
const PYTHON_SHIELD_FILE = path.join(PYTHON_SHIELD_DIR, 'sitecustomize.py');

export interface WorkspaceAuditFinding {
  file: string;
  severity: 'warn' | 'info';
  message: string;
}

const NODE_DISCORD_SHIELD_SOURCE = `// FACON HOST Discord.js Runtime Interaction Guard
// Automatically protects slash commands, buttons, and modals against >3s timeouts,
// missing deferReply(), reply-after-defer exceptions (40060), duplicate listeners,
// and unhandled rejections without altering command definitions.

import { createRequire } from 'node:module';
import path from 'node:path';

const AUTO_DEFER_MS = 850;
const IMMEDIATE_PREDEFER_AGE_MS = 900;
const DISCORD_EPOCH_MS = 1420070400000n;
const SEEN_INTERACTIONS = new Set();
const MAX_SEEN = 4096;

function getInteractionAgeMs(id) {
  try {
    if (!id) return 0;
    const createdMs = Number((BigInt(String(id)) >> 22n) + DISCORD_EPOCH_MS);
    if (!Number.isFinite(createdMs)) return 0;
    const age = Date.now() - createdMs;
    if (age < -1500 || age > 15000) return 0;
    return Math.max(0, age);
  } catch {
    return 0;
  }
}

function trackInteractionId(id) {
  if (!id) return true;
  if (SEEN_INTERACTIONS.has(id)) return false;
  SEEN_INTERACTIONS.add(id);
  if (SEEN_INTERACTIONS.size > MAX_SEEN) {
    const first = SEEN_INTERACTIONS.values().next().value;
    if (first !== undefined) SEEN_INTERACTIONS.delete(first);
  }
  return true;
}

function getCommandLabel(interaction) {
  try {
    if (interaction.commandName) {
      const sub = interaction.options?.getSubcommand?.(false);
      return sub ? '/' + interaction.commandName + ' ' + sub : '/' + interaction.commandName;
    }
    if (interaction.customId) return 'component:' + interaction.customId;
  } catch {
    // ignore option inspection edge cases
  }
  return 'interaction';
}

function stripReplyOnlyOptions(options) {
  if (typeof options === 'string') return { content: options };
  if (!options || typeof options !== 'object') return options;
  const copy = { ...options };
  delete copy.ephemeral;
  delete copy.fetchReply;
  delete copy.withResponse;
  delete copy.tts;
  delete copy.flags;
  return copy;
}

function formatErrorSummary(err) {
  if (!err) return 'Unknown command execution error';
  const msg = err instanceof Error ? err.message : String(err);
  return msg.slice(0, 220) || 'Unexpected execution failure';
}

function patchDiscordJsModule(djs) {
  if (!djs || djs.__faconShieldApplied) return;
  const {
    Client,
    ClientUser,
    CommandInteraction,
    MessageComponentInteraction,
    ModalSubmitInteraction,
  } = djs;

  if (!Client?.prototype) return;
  djs.__faconShieldApplied = true;

  const ACTIVITY_TYPE_LABELS = {
    0: 'Playing',
    1: 'Streaming',
    2: 'Listening',
    3: 'Watching',
    4: 'Custom',
    5: 'Competing',
  };

  const ACTIVE_CLIENTS = new Set();

  function extractNodeActivity(client) {
    try {
      const liveList = client?.user?.presence?.activities;
      const recordedList = client?._faconLastPresence?.activities;
      const ctorList = client?.options?.presence?.activities;
      const act =
        (Array.isArray(liveList) && liveList[0]) ||
        (Array.isArray(recordedList) && recordedList[0]) ||
        (Array.isArray(ctorList) && ctorList[0]) ||
        null;
      if (!act) return { activityType: null, activityName: null };
      const typeLabel = ACTIVITY_TYPE_LABELS[act.type] || 'Playing';
      const rawName = act.type === 4 ? act.state || act.name : act.name || act.state;
      return {
        activityType: typeLabel,
        activityName: rawName ? String(rawName).slice(0, 128) : null,
      };
    } catch {
      return { activityType: null, activityName: null };
    }
  }

  function emitNodeGateway(client, overrides = {}) {
    try {
      const user = client?.user;
      const botTag = user
        ? user.discriminator && user.discriminator !== '0'
          ? user.username + '#' + user.discriminator
          : '@' + user.username
        : null;
      const clearActivity = Boolean(overrides.clearActivity);
      const extracted = clearActivity
        ? { activityType: null, activityName: null }
        : extractNodeActivity(client);
      const rawStatus =
        overrides.presenceStatus ||
        client?.user?.presence?.status ||
        client?._faconLastPresence?.status ||
        client?.options?.presence?.status ||
        'online';
      const ping = Number(client?.ws?.ping);
      const payload = {
        connectionState: overrides.connectionState || 'online',
        presenceStatus: String(rawStatus || 'online'),
        botTag,
        botId: user?.id ? String(user.id) : null,
        activityType: overrides.activityType !== undefined ? overrides.activityType : extracted.activityType,
        activityName: overrides.activityName !== undefined ? overrides.activityName : extracted.activityName,
        latencyMs: Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null,
        shards: client?.ws?.shards?.size || 1,
        guildCount: client?.guilds?.cache?.size ?? null,
        event: overrides.event || null,
      };
      console.log('__FACON_GW__' + JSON.stringify(payload));
    } catch {
      // ignore telemetry serialization edge cases
    }
  }

  if (ClientUser?.prototype && typeof ClientUser.prototype.setPresence === 'function') {
    const origSetPresence = ClientUser.prototype.setPresence;
    ClientUser.prototype.setPresence = function faconSafeSetPresence(data) {
      if (this?.client && data && typeof data === 'object') {
        const prev = this.client._faconLastPresence || {};
        this.client._faconLastPresence = {
          status: data.status !== undefined ? data.status : prev.status,
          activities: data.activities !== undefined ? data.activities : prev.activities,
        };
      }
      const res = origSetPresence.call(this, data);
      if (this?.client && data?.status !== 'invisible') {
        emitNodeGateway(this.client, {
          connectionState: 'online',
          event: 'Presence updated',
        });
      }
      return res;
    };
  }

  if (!globalThis.__faconNodeShutdownRegistered) {
    globalThis.__faconNodeShutdownRegistered = true;
    const handleNodeGracefulStop = async () => {
      if (ACTIVE_CLIENTS.size === 0) return;
      await Promise.all(
        Array.from(ACTIVE_CLIENTS).map(async (cl) => {
          try {
            if (cl._faconHeartbeatTimer) {
              clearInterval(cl._faconHeartbeatTimer);
              cl._faconHeartbeatTimer = null;
            }
            emitNodeGateway(cl, {
              connectionState: 'offline',
              presenceStatus: 'offline',
              clearActivity: true,
              event: 'Graceful Discord offline shutdown',
            });
            try {
              cl.user?.setPresence({ status: 'invisible', activities: [] });
              await new Promise((r) => setTimeout(r, 250));
            } catch {
              // ignore
            }
            await Promise.race([
              Promise.resolve(cl.destroy?.()),
              new Promise((r) => setTimeout(r, 1000)),
            ]);
          } catch {
            // ignore shutdown error
          }
        })
      );
      process.exit(0);
    };

    const existingSigterm = process.listenerCount('SIGTERM');
    if (existingSigterm === 0) {
      process.once('SIGTERM', () => void handleNodeGracefulStop());
    }
  }

  const protos = [
    CommandInteraction?.prototype,
    MessageComponentInteraction?.prototype,
    ModalSubmitInteraction?.prototype,
  ].filter(Boolean);

  for (const proto of protos) {
    if (proto.__faconProtoPatched) continue;
    proto.__faconProtoPatched = true;

    const origDeferReply = proto.deferReply;
    const origReply = proto.reply;
    const origEditReply = proto.editReply;
    const origFollowUp = proto.followUp;
    const origShowModal = proto.showModal;
    const origDeferUpdate = proto.deferUpdate;
    const origUpdate = proto.update;

    if (typeof origDeferReply === 'function') {
      proto.deferReply = async function faconSafeDeferReply(options = {}) {
        if (this._faconDeferPromise) {
          await this._faconDeferPromise.catch(() => {});
        }
        if (this.deferred || this.replied) {
          return this;
        }
        const p = origDeferReply.call(this, options);
        this._faconDeferPromise = p;
        try {
          return await p;
        } finally {
          if (this._faconDeferPromise === p) this._faconDeferPromise = null;
        }
      };
    }

    if (typeof origReply === 'function') {
      proto.reply = async function faconSafeReply(options) {
        if (this._faconDeferPromise) {
          await this._faconDeferPromise.catch(() => {});
        }
        if (this.deferred && !this.replied && typeof origEditReply === 'function') {
          const res = await origEditReply.call(this, stripReplyOnlyOptions(options));
          this._faconFinalized = true;
          return res;
        }
        if (this.replied && typeof origFollowUp === 'function') {
          const res = await origFollowUp.call(this, options);
          this._faconFinalized = true;
          return res;
        }
        const res = await origReply.call(this, options);
        this._faconFinalized = true;
        return res;
      };
    }

    if (typeof origEditReply === 'function') {
      proto.editReply = async function faconSafeEditReply(options) {
        if (this._faconDeferPromise) {
          await this._faconDeferPromise.catch(() => {});
        }
        if (!this.deferred && !this.replied && typeof origReply === 'function') {
          const res = await origReply.call(this, options);
          this._faconFinalized = true;
          return res;
        }
        const res = await origEditReply.call(this, stripReplyOnlyOptions(options));
        this._faconFinalized = true;
        return res;
      };
    }

    if (typeof origFollowUp === 'function') {
      proto.followUp = async function faconSafeFollowUp(options) {
        if (this._faconDeferPromise) {
          await this._faconDeferPromise.catch(() => {});
        }
        if (!this.deferred && !this.replied && typeof origReply === 'function') {
          const res = await origReply.call(this, options);
          this._faconFinalized = true;
          return res;
        }
        const res = await origFollowUp.call(this, options);
        this._faconFinalized = true;
        return res;
      };
    }

    if (typeof origShowModal === 'function') {
      proto.showModal = async function faconSafeShowModal(...args) {
        this._faconModalShown = true;
        this._faconFinalized = true;
        return origShowModal.apply(this, args);
      };
    }

    if (typeof origDeferUpdate === 'function') {
      proto.deferUpdate = async function faconSafeDeferUpdate(options = {}) {
        if (this._faconDeferPromise) {
          await this._faconDeferPromise.catch(() => {});
        }
        if (this.deferred || this.replied) return this;
        const p = origDeferUpdate.call(this, options);
        this._faconDeferPromise = p;
        try {
          return await p;
        } finally {
          if (this._faconDeferPromise === p) this._faconDeferPromise = null;
        }
      };
    }

    if (typeof origUpdate === 'function') {
      proto.update = async function faconSafeUpdate(options) {
        if (this._faconDeferPromise) {
          await this._faconDeferPromise.catch(() => {});
        }
        if (this.deferred && !this.replied && typeof origEditReply === 'function') {
          const res = await origEditReply.call(this, stripReplyOnlyOptions(options));
          this._faconFinalized = true;
          return res;
        }
        if (this.replied && typeof origFollowUp === 'function') {
          const res = await origFollowUp.call(this, options);
          this._faconFinalized = true;
          return res;
        }
        const res = await origUpdate.call(this, options);
        this._faconFinalized = true;
        return res;
      };
    }
  }

  // Guard duplicate interactionCreate listeners and isolate async failures
  const origOn = Client.prototype.on;
  const origAddListener = Client.prototype.addListener;

  function wrapRegistration(origFn) {
    return function faconGuardedOn(eventName, listener) {
      if (eventName === 'interactionCreate' && typeof listener === 'function') {
        if (!this._faconInteractionHandlers) {
          this._faconInteractionHandlers = new WeakSet();
        }
        if (this._faconInteractionHandlers.has(listener)) {
          console.warn('[LISTENER GUARD] Ignored duplicate interactionCreate handler registration.');
          return this;
        }
        this._faconInteractionHandlers.add(listener);
        const existingCount = this.listenerCount('interactionCreate');
        if (existingCount >= 1) {
          console.warn(
            '[LISTENER GUARD] Multiple interactionCreate listeners detected (' +
              (existingCount + 1) +
              '). Guarding against duplicate replies.'
          );
        }
      }
      return origFn.call(this, eventName, listener);
    };
  }

  Client.prototype.on = wrapRegistration(origOn);
  Client.prototype.addListener = wrapRegistration(origAddListener);

  const origEmit = Client.prototype.emit;
  Client.prototype.emit = function faconGuardedEmit(eventName, ...args) {
    ACTIVE_CLIENTS.add(this);

    if (eventName === 'ready' || eventName === 'clientReady' || eventName === 'shardReady') {
      if (this.options?.presence && !this._faconLastPresence) {
        this._faconLastPresence = this.options.presence;
      }
      emitNodeGateway(this, {
        connectionState: 'online',
        event: 'Discord Gateway Ready',
      });
      const delayedRecheck = setTimeout(() => {
        emitNodeGateway(this, { connectionState: 'online' });
      }, 1500);
      if (typeof delayedRecheck.unref === 'function') delayedRecheck.unref();

      const warmDiscordRest = () => {
        try {
          if (typeof fetch === 'function') {
            void fetch('https://discord.com/api/v10/gateway', {
              method: 'HEAD',
              signal: AbortSignal.timeout(4000),
            }).catch(() => {});
          }
        } catch {
          // ignore pre-warm network blip
        }
      };
      warmDiscordRest();

      if (!this._faconHeartbeatTimer) {
        this._faconHeartbeatTimer = setInterval(() => {
          if (this.isReady?.()) {
            emitNodeGateway(this, { connectionState: 'online' });
            warmDiscordRest();
          }
        }, 15000);
        if (typeof this._faconHeartbeatTimer.unref === 'function') {
          this._faconHeartbeatTimer.unref();
        }
      }
      return origEmit.call(this, eventName, ...args);
    }

    if (eventName === 'shardResume') {
      const hasLiveAct = Array.isArray(this.user?.presence?.activities) && this.user.presence.activities.length > 0;
      if (!hasLiveAct && this._faconLastPresence?.activities?.length) {
        try {
          this.user?.setPresence(this._faconLastPresence);
        } catch {
          // ignore restore error
        }
      }
      emitNodeGateway(this, {
        connectionState: 'online',
        event: 'Discord Gateway Resumed',
      });
      return origEmit.call(this, eventName, ...args);
    }

    if (eventName === 'shardDisconnect') {
      emitNodeGateway(this, {
        connectionState: 'offline',
        presenceStatus: 'offline',
        clearActivity: true,
        event: 'Discord Shard Disconnected',
      });
      return origEmit.call(this, eventName, ...args);
    }

    if (eventName !== 'interactionCreate' || !args[0]) {
      return origEmit.call(this, eventName, ...args);
    }

    const interaction = args[0];
    if (!trackInteractionId(interaction.id)) {
      console.warn(
        '[INTERACTION GUARD] Prevented duplicate processing of interaction ' + interaction.id
      );
      return false;
    }

    if (typeof interaction.isRepliable !== 'function' || !interaction.isRepliable()) {
      const listeners = this.rawListeners('interactionCreate');
      for (const fn of listeners) {
        Promise.resolve()
          .then(() => fn.call(this, interaction))
          .catch((err) => {
            console.error(
              '[INTERACTION ERROR]',
              getCommandLabel(interaction),
              err instanceof Error ? err.stack || err.message : err
            );
          });
      }
      return listeners.length > 0;
    }

    const cmdLabel = getCommandLabel(interaction);
    const startedAt = Date.now();
    const initialAgeMs = getInteractionAgeMs(interaction.id);
    const listeners = this.rawListeners('interactionCreate');

    if (listeners.length === 0) {
      console.error(
        '[INTERACTION ERROR] Received ' + cmdLabel + ' with 0 registered interactionCreate listeners.'
      );
      Promise.resolve(
        interaction.reply({
          content: '⚠️ No interaction handler is registered for ' + cmdLabel + '.',
          flags: 64,
        })
      ).catch(() => {});
      return false;
    }

    if (
      initialAgeMs >= IMMEDIATE_PREDEFER_AGE_MS &&
      typeof interaction.isCommand === 'function' &&
      interaction.isCommand() &&
      !interaction.deferred &&
      !interaction.replied
    ) {
      console.warn(
        '[INTERACTION TIMING] ' +
          cmdLabel +
          ' arrived ' +
          Math.round(initialAgeMs) +
          'ms after Discord creation — immediately pre-deferring before handler.'
      );
      void Promise.resolve(interaction.deferReply()).catch(() => {});
    }

    const delayMs = Math.max(50, AUTO_DEFER_MS - initialAgeMs);
    const watchdog = setTimeout(() => {
      if (interaction.deferred || interaction.replied || interaction._faconModalShown) {
        return;
      }
      console.warn(
        '[INTERACTION GUARD] Auto-deferring slow command ' +
          cmdLabel +
          ' at ' +
          (Date.now() - startedAt) +
          'ms (Discord age ~' +
          Math.round(initialAgeMs + (Date.now() - startedAt)) +
          'ms) to prevent Discord 3s timeout.'
      );
      Promise.resolve(interaction.deferReply()).catch((err) => {
        console.error('[INTERACTION GUARD] Auto-defer failed for ' + cmdLabel + ':', err?.message || err);
      });
    }, delayMs);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    (async () => {
      let lastError = null;
      try {
        for (const fn of listeners) {
          try {
            await fn.call(this, interaction);
          } catch (err) {
            lastError = err;
            console.error(
              '[COMMAND ERROR] ' +
                cmdLabel +
                ' (guild=' +
                (interaction.guildId || 'DM') +
                ', user=' +
                (interaction.user?.id || 'unknown') +
                '):',
              err instanceof Error ? err.stack || err.message : err
            );
          }
        }

        if (interaction._faconDeferPromise) {
          await interaction._faconDeferPromise.catch(() => {});
        }

        if (!interaction._faconFinalized && !interaction._faconModalShown) {
          if (lastError) {
            const errMsg =
              '⚠️ Command \`' +
              cmdLabel +
              '\` failed: ' +
              formatErrorSummary(lastError) +
              '. Check FACON HOST Console logs.';
            if (interaction.deferred && !interaction.replied) {
              await interaction.editReply({ content: errMsg }).catch(() => {});
            } else if (!interaction.replied) {
              await interaction.reply({ content: errMsg, flags: 64 }).catch(() => {});
            }
          } else if (!interaction.deferred && !interaction.replied) {
            console.error(
              '[INTERACTION ERROR] Handler for ' +
                cmdLabel +
                ' completed without calling reply(), deferReply(), or showModal().'
            );
            await interaction
              .reply({
                content:
                  '⚠️ Command \`' +
                  cmdLabel +
                  '\` did not send a reply. Check command routing in FACON HOST.',
                flags: 64,
              })
              .catch(() => {});
          } else if (interaction.deferred && !interaction._faconFinalized) {
            console.error(
              '[INTERACTION ERROR] Handler for ' +
                cmdLabel +
                ' deferred the interaction but exited without calling editReply() or followUp().'
            );
            await interaction
              .editReply({
                content:
                  '⚠️ Command \`' +
                  cmdLabel +
                  '\` deferred without a final response. Check FACON HOST Console logs.',
              })
              .catch(() => {});
          }
        }
      } finally {
        clearTimeout(watchdog);
      }
    })();

    return true;
  };
}

const argv1 = process.argv[1] || '';
const isPackageTool = /(?:^|[\\/])(npm-cli|npx-cli|yarn|pnpm)(?:\.[cm]?js)?$/.test(argv1);

if (!isPackageTool) {
  let loadedAny = false;
  const resolvers = [];
  try {
    resolvers.push(createRequire(path.join(process.cwd(), 'package.json')));
  } catch {
    // ignore if cwd has no package.json path context
  }
  try {
    resolvers.push(createRequire(import.meta.url));
  } catch {
    // ignore
  }

  for (const reqFn of resolvers) {
    try {
      const djs = reqFn('discord.js');
      if (djs && !djs.__faconShieldApplied) {
        patchDiscordJsModule(djs);
      }
      loadedAny = true;
    } catch {
      // discord.js not present in this resolution root
    }
  }

  if (loadedAny) {
    if (process.listenerCount('unhandledRejection') === 0) {
      process.on('unhandledRejection', (err) => {
        console.error('[ASYNC UNHANDLED REJECTION]', err instanceof Error ? err.stack || err.message : err);
      });
    }
    if (process.env.__FACON_NODE_SHIELD_LOGGED !== '1') {
      process.env.__FACON_NODE_SHIELD_LOGGED = '1';
      console.log('[SHIELD] FACON Discord.js Interaction & Presence Guard active (<3s auto-defer & live status sync).');
    }
  }
}
`;

const PYTHON_DISCORD_SHIELD_SOURCE = `# FACON HOST Python discord.py Runtime Interaction Guard
# Loaded automatically via sitecustomize.py when running Discord bots on FACON HOST.
# Protects slash commands & components from 3s Discord timeouts, missing defer(),
# InteractionResponded (40060) errors, unhandled CommandTree errors, and silent handlers.

import asyncio
import builtins
from collections import OrderedDict, deque
import functools
import inspect
import json
import math
import signal
import socket
import sys
import time
import traceback
import weakref

_DISCORD_EPOCH_MS = 1420070400000
_AUTO_DEFER_DEADLINE_MS = 850.0
_IMMEDIATE_PREDEFER_AGE_MS = 900.0

_orig_socket_getaddrinfo = socket.getaddrinfo
if not getattr(_orig_socket_getaddrinfo, "_facon_ipv4_patched", False):
    @functools.wraps(_orig_socket_getaddrinfo)
    def _facon_ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        # Cloud Run containers can stall for 2-5s on IPv6 (AAAA) SYN handshakes to discord.com.
        # Prefer IPv4 (AF_INET) whenever caller left family unspecified (AF_UNSPEC / 0).
        if family in (0, getattr(socket, "AF_UNSPEC", 0)):
            try:
                res = _orig_socket_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
                if res:
                    return res
            except socket.gaierror:
                pass
        return _orig_socket_getaddrinfo(host, port, family, type, proto, flags)

    setattr(_facon_ipv4_getaddrinfo, "_facon_ipv4_patched", True)
    socket.getaddrinfo = _facon_ipv4_getaddrinfo

_orig_import = builtins.__import__
_shield_applied = False
_shield_applying = False
_seen_interaction_ids = deque(maxlen=4096)
_interaction_states = OrderedDict()
_active_clients = weakref.WeakSet()
_client_presence = weakref.WeakKeyDictionary()
_signal_loops_hooked = weakref.WeakSet()
_lag_monitored_loops = weakref.WeakSet()


def _get_interaction_age_ms(interaction):
    try:
        raw_id = getattr(interaction, "id", None)
        if not raw_id:
            return 0.0
        created_ms = (int(raw_id) >> 22) + _DISCORD_EPOCH_MS
        age_ms = (time.time() * 1000.0) - float(created_ms)
        if age_ms < -1500.0 or age_ms > 15000.0:
            return 0.0
        return max(0.0, age_ms)
    except Exception:
        return 0.0


def _get_inter_state(interaction):
    key = getattr(interaction, "id", None) or id(interaction)
    st = _interaction_states.get(key)
    if st is None:
        st = {"lock": None, "finalized": False, "modal_sent": False}
        _interaction_states[key] = st
        if len(_interaction_states) > 4096:
            _interaction_states.popitem(last=False)
    return st


def _track_interaction_id(inter_id):
    if not inter_id:
        return True
    if inter_id in _seen_interaction_ids:
        return False
    _seen_interaction_ids.append(inter_id)
    return True


def _format_cmd_name(interaction):
    try:
        cmd = getattr(interaction, "command", None)
        if cmd is not None:
            qname = getattr(cmd, "qualified_name", None) or getattr(cmd, "name", None)
            if qname:
                return f"/{qname}"
        data = getattr(interaction, "data", None) or {}
        if isinstance(data, dict):
            if data.get("name"):
                return f"/{data.get('name')}"
            if data.get("custom_id"):
                return f"component:{data.get('custom_id')}"
    except Exception:
        pass
    return "/command"


async def _send_honest_fallback(interaction, message_text):
    try:
        st = _get_inter_state(interaction)
        lock = st.get("lock")
        if lock is not None:
            async with lock:
                pass
        if st["finalized"] or st["modal_sent"]:
            return
        if not interaction.response.is_done():
            await interaction.response.send_message(message_text, ephemeral=True)
        else:
            await interaction.followup.send(message_text, ephemeral=True)
        st["finalized"] = True
    except Exception as send_err:
        print(f"[INTERACTION GUARD] Fallback error reply failed: {send_err}", file=sys.stderr, flush=True)


def _apply_facon_discord_py_shield():
    global _shield_applied, _shield_applying
    if _shield_applied or _shield_applying:
        return
    _shield_applying = True

    try:
        import discord
        from discord import app_commands
        from discord.interactions import Interaction, InteractionResponse
    except Exception:
        _shield_applying = False
        return

    _shield_applied = True
    _shield_applying = False
    builtins.__import__ = _orig_import

    try:
        import aiohttp
        if hasattr(aiohttp, "TCPConnector") and not getattr(aiohttp.TCPConnector.__init__, "_facon_ipv4_patched", False):
            _orig_tcp_init = aiohttp.TCPConnector.__init__
            @functools.wraps(_orig_tcp_init)
            def _facon_tcp_connector_init(self, *args, **kwargs):
                if "family" not in kwargs or kwargs.get("family") in (None, 0, getattr(socket, "AF_UNSPEC", 0)):
                    kwargs["family"] = socket.AF_INET
                if "ttl_dns_cache" not in kwargs:
                    kwargs["ttl_dns_cache"] = 300
                if "keepalive_timeout" not in kwargs:
                    kwargs["keepalive_timeout"] = 60.0
                return _orig_tcp_init(self, *args, **kwargs)
            setattr(_facon_tcp_connector_init, "_facon_ipv4_patched", True)
            aiohttp.TCPConnector.__init__ = _facon_tcp_connector_init
    except Exception:
        pass

    orig_defer = InteractionResponse.defer
    orig_send_message = InteractionResponse.send_message
    orig_edit_message = InteractionResponse.edit_message
    orig_send_modal = InteractionResponse.send_modal
    orig_edit_original = Interaction.edit_original_response
    orig_followup_desc = Interaction.__dict__.get("followup")
    orig_tree_call = app_commands.CommandTree._call
    orig_tree_on_error = app_commands.CommandTree.on_error
    orig_client_run_event = discord.Client._run_event

    def _get_lock(interaction):
        st = _get_inter_state(interaction)
        if st["lock"] is None:
            st["lock"] = asyncio.Lock()
        return st["lock"]

    async def safe_defer(self, *, ephemeral=False, thinking=False):
        parent = self._parent
        lock = _get_lock(parent)
        async with lock:
            if self.is_done():
                return
            return await orig_defer(self, ephemeral=ephemeral, thinking=thinking)

    async def safe_send_message(self, *args, **kwargs):
        parent = self._parent
        lock = _get_lock(parent)
        async with lock:
            pass
        _get_inter_state(parent)["finalized"] = True
        if self.is_done():
            followup_kwargs = dict(kwargs)
            delete_after = followup_kwargs.pop("delete_after", None)
            followup_kwargs.pop("suppress_embeds", None)
            if args and "content" not in followup_kwargs:
                followup_kwargs["content"] = args[0]
            msg = await parent.followup.send(**followup_kwargs)
            if delete_after is not None and msg is not None and hasattr(msg, "delete"):
                async def _delayed_delete(target_msg, delay_s):
                    try:
                        await asyncio.sleep(float(delay_s))
                        await target_msg.delete()
                    except Exception:
                        pass
                asyncio.create_task(_delayed_delete(msg, delete_after))
            return msg
        send_started = time.monotonic()
        try:
            return await orig_send_message(self, *args, **kwargs)
        except discord.NotFound as nf_err:
            if getattr(nf_err, "code", None) == 10062:
                age_at_send = int(_get_interaction_age_ms(parent))
                rtt_ms = int((time.monotonic() - send_started) * 1000)
                print(
                    f"[INTERACTION TIMING] 10062 Unknown interaction on {_format_cmd_name(parent)}: "
                    f"age_at_send={age_at_send}ms, callback_rtt={rtt_ms}ms (IPv4 forced, Cloud Run CPU/network may have throttled).",
                    file=sys.stderr,
                    flush=True,
                )
            raise

    async def safe_edit_message(self, *args, **kwargs):
        parent = self._parent
        lock = _get_lock(parent)
        async with lock:
            pass
        _get_inter_state(parent)["finalized"] = True
        if self.is_done():
            allowed_keys = {"content", "embed", "embeds", "attachments", "view", "allowed_mentions", "delete_after"}
            edit_kwargs = {k: v for k, v in kwargs.items() if k in allowed_keys}
            if args and "content" not in edit_kwargs:
                edit_kwargs["content"] = args[0]
            return await parent.edit_original_response(**edit_kwargs)
        return await orig_edit_message(self, *args, **kwargs)

    async def safe_send_modal(self, modal):
        parent = self._parent
        st = _get_inter_state(parent)
        st["modal_sent"] = True
        st["finalized"] = True
        return await orig_send_modal(self, modal)

    async def safe_edit_original_response(self, *args, **kwargs):
        lock = _get_lock(self)
        async with lock:
            pass
        _get_inter_state(self)["finalized"] = True
        if not self.response.is_done():
            send_kwargs = {k: v for k, v in kwargs.items() if k in {
                "content", "embed", "embeds", "view", "allowed_mentions", "delete_after"
            }}
            if args and "content" not in send_kwargs:
                send_kwargs["content"] = args[0]
            return await orig_send_message(self.response, **send_kwargs)
        return await orig_edit_original(self, *args, **kwargs)

    if orig_followup_desc is not None:
        class _TrackedFollowupDescriptor:
            def __get__(self, instance, owner=None):
                wh = orig_followup_desc.__get__(instance, owner)
                if instance is not None and wh is not None and not getattr(wh.send, "_facon_wh_wrapped", False):
                    orig_wh_send = wh.send
                    parent_interaction = instance
                    @functools.wraps(orig_wh_send)
                    async def tracked_followup_send(*f_args, **f_kwargs):
                        _get_inter_state(parent_interaction)["finalized"] = True
                        return await orig_wh_send(*f_args, **f_kwargs)
                    setattr(tracked_followup_send, "_facon_wh_wrapped", True)
                    wh.send = tracked_followup_send
                return wh
        Interaction.followup = _TrackedFollowupDescriptor()

    InteractionResponse.defer = safe_defer
    InteractionResponse.send_message = safe_send_message
    InteractionResponse.edit_message = safe_edit_message
    InteractionResponse.send_modal = safe_send_modal
    Interaction.edit_original_response = safe_edit_original_response

    async def guarded_tree_on_error(self, interaction, error):
        cmd_label = _format_cmd_name(interaction)
        user = getattr(interaction, "user", None)
        guild_id = getattr(interaction, "guild_id", None) or "DM"
        print(
            f"[COMMAND ERROR] {cmd_label} (guild={guild_id}, user={user}): {type(error).__name__}: {error}",
            file=sys.stderr,
            flush=True,
        )
        traceback.print_exception(type(error), error, error.__traceback__, file=sys.stderr)
        sys.stderr.flush()

        # Run custom subclass on_error if overridden; otherwise avoid silent discord.py logger-only trap
        if type(self).on_error is not guarded_tree_on_error and orig_tree_on_error is not guarded_tree_on_error:
            try:
                await orig_tree_on_error(self, interaction, error)
            except Exception as handler_exc:
                print(f"[COMMAND ERROR] Custom tree.on_error raised: {handler_exc}", file=sys.stderr, flush=True)

        st = _get_inter_state(interaction)
        if not st["finalized"] and not st["modal_sent"]:
            await _send_honest_fallback(
                interaction,
                f"⚠️ Command \`{cmd_label}\` failed ({type(error).__name__}: {str(error)[:160]}). Check FACON HOST Console logs.",
            )

    def _ensure_instance_error_hook(tree_self):
        current_err_fn = tree_self.__dict__.get("on_error")
        if current_err_fn is not None and not getattr(current_err_fn, "_facon_wrapped", False):
            orig_inst_err = current_err_fn
            @functools.wraps(orig_inst_err)
            async def wrapped_inst_on_error(interaction, error):
                cmd_label = _format_cmd_name(interaction)
                user = getattr(interaction, "user", None)
                guild_id = getattr(interaction, "guild_id", None) or "DM"
                print(
                    f"[COMMAND ERROR] {cmd_label} (guild={guild_id}, user={user}): {type(error).__name__}: {error}",
                    file=sys.stderr,
                    flush=True,
                )
                traceback.print_exception(type(error), error, error.__traceback__, file=sys.stderr)
                sys.stderr.flush()
                try:
                    await orig_inst_err(interaction, error)
                except Exception as handler_exc:
                    print(f"[COMMAND ERROR] @tree.error handler raised: {handler_exc}", file=sys.stderr, flush=True)
                st = _get_inter_state(interaction)
                if not st["finalized"] and not st["modal_sent"]:
                    await _send_honest_fallback(
                        interaction,
                        f"⚠️ Command \`{cmd_label}\` failed ({type(error).__name__}: {str(error)[:160]}). Check FACON HOST Console logs.",
                    )
            setattr(wrapped_inst_on_error, "_facon_wrapped", True)
            tree_self.on_error = wrapped_inst_on_error

    async def guarded_tree_call(self, interaction):
        _ensure_instance_error_hook(self)
        if getattr(interaction, "type", None) == discord.InteractionType.autocomplete:
            return await orig_tree_call(self, interaction)

        if not _track_interaction_id(getattr(interaction, "id", None)):
            print(
                f"[INTERACTION GUARD] Ignored duplicate execution of interaction {getattr(interaction, 'id', None)}",
                file=sys.stderr,
                flush=True,
            )
            return

        cmd_label = _format_cmd_name(interaction)
        started = time.monotonic()
        initial_age_ms = _get_interaction_age_ms(interaction)
        lock = _get_lock(interaction)
        st = _get_inter_state(interaction)

        if initial_age_ms >= _IMMEDIATE_PREDEFER_AGE_MS and not interaction.response.is_done():
            try:
                print(
                    f"[INTERACTION TIMING] {cmd_label} arrived {int(initial_age_ms)}ms after Discord creation — immediately pre-deferring.",
                    flush=True,
                )
                await safe_defer(interaction.response, thinking=True)
            except Exception as pre_err:
                print(
                    f"[INTERACTION GUARD] Immediate pre-defer failed for {cmd_label}: {pre_err}",
                    file=sys.stderr,
                    flush=True,
                )

        defer_delay_s = max(0.05, (_AUTO_DEFER_DEADLINE_MS - initial_age_ms) / 1000.0)

        async def _auto_defer_watchdog():
            try:
                await asyncio.sleep(defer_delay_s)
                async with lock:
                    if (
                        not interaction.response.is_done()
                        and not st["finalized"]
                        and not st["modal_sent"]
                    ):
                        elapsed_ms = int((time.monotonic() - started) * 1000)
                        total_age_ms = int(initial_age_ms + elapsed_ms)
                        print(
                            f"[INTERACTION GUARD] Auto-deferred slow command {cmd_label} after {elapsed_ms}ms (Discord age ~{total_age_ms}ms)",
                            flush=True,
                        )
                        await orig_defer(interaction.response, thinking=True)
            except asyncio.CancelledError:
                return
            except Exception as defer_err:
                print(
                    f"[INTERACTION GUARD] Auto-defer failed for {cmd_label}: {defer_err}",
                    file=sys.stderr,
                    flush=True,
                )

        watchdog_task = asyncio.create_task(_auto_defer_watchdog())
        unhandled_exc = None
        try:
            return await orig_tree_call(self, interaction)
        except BaseException as exc:
            unhandled_exc = exc
            print(
                f"[COMMAND ERROR] Unhandled exception in {cmd_label}: {type(exc).__name__}: {exc}",
                file=sys.stderr,
                flush=True,
            )
            traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
            sys.stderr.flush()
            raise
        finally:
            if not watchdog_task.done():
                watchdog_task.cancel()
                try:
                    await watchdog_task
                except BaseException:
                    pass
            async with lock:
                pass
            if not st["finalized"] and not st["modal_sent"]:
                if unhandled_exc is not None:
                    await _send_honest_fallback(
                        interaction,
                        f"⚠️ Command \`{cmd_label}\` failed ({type(unhandled_exc).__name__}). Check FACON HOST Console logs.",
                    )
                else:
                    print(
                        f"[INTERACTION WARNING] Command {cmd_label} completed without sending a response!",
                        file=sys.stderr,
                        flush=True,
                    )
                    await _send_honest_fallback(
                        interaction,
                        f"⚠️ Command \`{cmd_label}\` finished without producing a response. Check FACON HOST Console logs.",
                    )

    orig_change_presence = discord.Client.change_presence
    orig_client_close = discord.Client.close

    _ACTIVITY_LABELS = {
        0: "Playing",
        1: "Streaming",
        2: "Listening",
        3: "Watching",
        4: "Custom",
        5: "Competing",
    }

    def _extract_py_presence(client):
        rec = _client_presence.get(client, {})
        act = getattr(client, "activity", None) or rec.get("activity")
        raw_status = getattr(client, "status", None) or rec.get("status")
        status_str = str(raw_status).split(".")[-1].lower() if raw_status is not None else "online"
        if status_str == "dnd":
            status_str = "dnd"
        elif status_str not in ("online", "idle", "dnd", "invisible", "offline"):
            status_str = "online"

        activity_type = None
        activity_name = None
        if act is not None:
            t = getattr(act, "type", None)
            t_val = getattr(t, "value", t)
            activity_type = _ACTIVITY_LABELS.get(t_val, "Playing")
            if t_val == 4:
                raw_name = getattr(act, "state", None) or getattr(act, "name", None)
            else:
                raw_name = getattr(act, "name", None) or getattr(act, "state", None)
            if raw_name:
                activity_name = str(raw_name)[:128]
        return status_str, activity_type, activity_name

    def _emit_py_gateway(client, connection_state="online", status_override=None, clear_activity=False, event=None):
        try:
            u = getattr(client, "user", None)
            bot_tag = None
            bot_id = None
            if u is not None:
                disc = getattr(u, "discriminator", "0")
                bot_tag = f"@{u.name}" if (not disc or disc == "0") else f"{u.name}#{disc}"
                bot_id = str(u.id)

            if clear_activity:
                p_status = status_override or "offline"
                act_type = None
                act_name = None
            else:
                p_status, act_type, act_name = _extract_py_presence(client)
                if status_override:
                    p_status = status_override

            lat = getattr(client, "latency", None)
            lat_ms = None
            if isinstance(lat, (int, float)) and not math.isnan(lat) and not math.isinf(lat) and lat >= 0:
                lat_ms = int(round(lat * 1000))

            guilds = getattr(client, "guilds", None)
            guild_count = len(guilds) if guilds is not None else None
            shards = getattr(client, "shard_count", None) or 1

            payload = {
                "connectionState": connection_state,
                "presenceStatus": p_status,
                "botTag": bot_tag,
                "botId": bot_id,
                "activityType": act_type,
                "activityName": act_name,
                "latencyMs": lat_ms,
                "shards": shards,
                "guildCount": guild_count,
                "event": event,
            }
            print("__FACON_GW__" + json.dumps(payload, separators=(",", ":")), flush=True)
        except Exception:
            pass

    def _ensure_loop_signal_hook():
        try:
            loop = asyncio.get_running_loop()
            if loop in _signal_loops_hooked:
                return
            _signal_loops_hooked.add(loop)

            async def _graceful_sigterm_exit():
                for cl in list(_active_clients):
                    try:
                        if cl.is_closed():
                            continue
                        _emit_py_gateway(
                            cl,
                            connection_state="offline",
                            status_override="offline",
                            clear_activity=True,
                            event="Graceful offline shutdown (SIGTERM)",
                        )
                        try:
                            await asyncio.wait_for(
                                orig_change_presence(cl, status=discord.Status.offline, activity=None),
                                timeout=0.6,
                            )
                        except Exception:
                            pass
                        try:
                            await asyncio.wait_for(orig_client_close(cl), timeout=1.3)
                        except Exception:
                            pass
                    except Exception:
                        pass

            def _on_sigterm():
                try:
                    asyncio.ensure_future(_graceful_sigterm_exit(), loop=loop)
                except Exception:
                    sys.exit(0)

            try:
                loop.add_signal_handler(signal.SIGTERM, _on_sigterm)
            except (NotImplementedError, RuntimeError):
                pass
        except Exception:
            pass

    async def tracked_change_presence(self, *, activity=discord.utils.MISSING, status=discord.utils.MISSING):
        _active_clients.add(self)
        rec = _client_presence.setdefault(self, {})
        if activity is not discord.utils.MISSING:
            rec["activity"] = activity
        if status is not discord.utils.MISSING:
            rec["status"] = status
        res = await orig_change_presence(self, activity=activity, status=status)
        if not self.is_closed():
            st_val, _, _ = _extract_py_presence(self)
            conn = "offline" if st_val in ("invisible", "offline") else "online"
            _emit_py_gateway(self, connection_state=conn, event="Presence updated")
        return res

    async def tracked_client_close(self):
        _emit_py_gateway(
            self,
            connection_state="offline",
            status_override="offline",
            clear_activity=True,
            event="Discord Gateway client closed",
        )
        return await orig_client_close(self)

    def _start_py_gateway_heartbeat(client):
        if getattr(client, "_facon_hb_started", False):
            return
        try:
            setattr(client, "_facon_hb_started", True)
        except Exception:
            pass

        async def _prewarm_discord_rest():
            try:
                http_obj = getattr(client, "http", None)
                session = (
                    getattr(http_obj, "_HTTPClient__session", None)
                    or getattr(http_obj, "session", None)
                )
                if session is not None and not getattr(session, "closed", True):
                    async with session.head("https://discord.com/api/v10/gateway", timeout=4) as resp:
                        await resp.release()
            except Exception:
                pass

        async def _hb():
            try:
                await asyncio.sleep(1.5)
                if not client.is_closed() and client.is_ready():
                    _emit_py_gateway(client, connection_state="online")
                    await _prewarm_discord_rest()
                while not client.is_closed():
                    await asyncio.sleep(15.0)
                    if not client.is_closed() and client.is_ready():
                        _emit_py_gateway(client, connection_state="online")
                        await _prewarm_discord_rest()
            except asyncio.CancelledError:
                return
            except Exception:
                return

        asyncio.create_task(_hb())

    def _ensure_loop_lag_monitor(loop):
        try:
            if loop in _lag_monitored_loops:
                return
            _lag_monitored_loops.add(loop)

            async def _lag_watch():
                last_warn = 0.0
                interval = 1.0
                try:
                    while True:
                        t0 = time.monotonic()
                        await asyncio.sleep(interval)
                        drift_ms = int((time.monotonic() - t0 - interval) * 1000)
                        if drift_ms >= 900:
                            now_m = time.monotonic()
                            if now_m - last_warn >= 60.0:
                                last_warn = now_m
                                print(
                                    f"[PERF WARNING] Python asyncio event loop delayed by {drift_ms}ms (sync I/O or container CPU throttling when browser tabs are idle).",
                                    file=sys.stderr,
                                    flush=True,
                                )
                except asyncio.CancelledError:
                    return
                except Exception:
                    return

            loop.create_task(_lag_watch())
        except Exception:
            pass

    async def guarded_run_event(self, coro, event_name, *args, **kwargs):
        _active_clients.add(self)
        _ensure_loop_signal_hook()
        try:
            _ensure_loop_lag_monitor(asyncio.get_running_loop())
        except Exception:
            pass

        if event_name == "on_ready":
            if self not in _client_presence:
                init_act = getattr(self, "activity", None)
                init_st = getattr(self, "status", None)
                if init_act is not None or init_st is not None:
                    _client_presence[self] = {"activity": init_act, "status": init_st}
            try:
                return await orig_client_run_event(self, coro, event_name, *args, **kwargs)
            finally:
                _emit_py_gateway(self, connection_state="online", event="Discord Gateway Ready")
                _start_py_gateway_heartbeat(self)

        if event_name == "on_resumed":
            rec = _client_presence.get(self, {})
            if rec.get("activity") is not None and getattr(self, "activity", None) is None:
                try:
                    await orig_change_presence(
                        self,
                        activity=rec["activity"],
                        status=rec.get("status", discord.utils.MISSING),
                    )
                except Exception:
                    pass
            _emit_py_gateway(self, connection_state="online", event="Discord Gateway Resumed")
            return await orig_client_run_event(self, coro, event_name, *args, **kwargs)

        if event_name == "on_disconnect":
            _emit_py_gateway(
                self,
                connection_state="offline" if self.is_closed() else "connecting",
                status_override="offline",
                clear_activity=True,
                event="Discord Gateway Disconnected",
            )
            return await orig_client_run_event(self, coro, event_name, *args, **kwargs)

        if event_name == "on_interaction" and args:
            interaction = args[0]
            if isinstance(interaction, Interaction):
                cmd_label = _format_cmd_name(interaction)
                lock = _get_lock(interaction)
                st = _get_inter_state(interaction)
                async def _event_watchdog():
                    try:
                        await asyncio.sleep(1.8)
                        async with lock:
                            if (
                                interaction.type == discord.InteractionType.application_command
                                and not interaction.response.is_done()
                                and not st["finalized"]
                                and not st["modal_sent"]
                            ):
                                print(
                                    f"[INTERACTION GUARD] Auto-deferred on_interaction {cmd_label} after 1.8s",
                                    flush=True,
                                )
                                await orig_defer(interaction.response, thinking=True)
                    except asyncio.CancelledError:
                        return
                    except Exception:
                        pass
                w_task = asyncio.create_task(_event_watchdog())
                try:
                    return await orig_client_run_event(self, coro, event_name, *args, **kwargs)
                except BaseException as exc:
                    print(
                        f"[COMMAND ERROR] on_interaction failed for {cmd_label}: {type(exc).__name__}: {exc}",
                        file=sys.stderr,
                        flush=True,
                    )
                    traceback.print_exception(type(exc), exc, exc.__traceback__, file=sys.stderr)
                    await _send_honest_fallback(
                        interaction,
                        f"⚠️ Interaction handler for \`{cmd_label}\` failed ({type(exc).__name__}).",
                    )
                finally:
                    if not w_task.done():
                        w_task.cancel()
                        try:
                            await w_task
                        except BaseException:
                            pass
        return await orig_client_run_event(self, coro, event_name, *args, **kwargs)

    discord.Client.change_presence = tracked_change_presence
    discord.Client.close = tracked_client_close
    app_commands.CommandTree.on_error = guarded_tree_on_error
    app_commands.CommandTree._call = guarded_tree_call
    discord.Client._run_event = guarded_run_event
    print("[SHIELD] FACON Discord.py Interaction & Presence Guard active (<3s auto-defer & live status sync).", flush=True)


def _facon_import_hook(name, globals=None, locals=None, fromlist=(), level=0):
    mod = _orig_import(name, globals, locals, fromlist, level)
    if not _shield_applied and (name == "discord" or name.startswith("discord.")):
        app_cmd_mod = sys.modules.get("discord.app_commands")
        inter_mod = sys.modules.get("discord.interactions")
        if (
            app_cmd_mod is not None
            and inter_mod is not None
            and hasattr(app_cmd_mod, "CommandTree")
            and hasattr(inter_mod, "InteractionResponse")
            and hasattr(sys.modules.get("discord"), "Client")
        ):
            _apply_facon_discord_py_shield()
    return mod


builtins.__import__ = _facon_import_hook
`;

export function ensureDiscordShieldArtifacts(): {
  nodeShieldImportUrl: string;
  pythonShieldDir: string;
} {
  fs.mkdirSync(NODE_SHIELD_DIR, { recursive: true });
  fs.mkdirSync(PYTHON_SHIELD_DIR, { recursive: true });

  fs.writeFileSync(NODE_SHIELD_FILE, NODE_DISCORD_SHIELD_SOURCE, 'utf8');
  fs.writeFileSync(PYTHON_SHIELD_FILE, PYTHON_DISCORD_SHIELD_SOURCE, 'utf8');

  return {
    nodeShieldImportUrl: pathToFileURL(NODE_SHIELD_FILE).href,
    pythonShieldDir: PYTHON_SHIELD_DIR,
  };
}

export function auditDiscordBotWorkspace(
  files: { path: string; content: string; isDirectory?: boolean }[]
): WorkspaceAuditFinding[] {
  const findings: WorkspaceAuditFinding[] = [];
  let interactionListenerCount = 0;

  for (const file of files) {
    if (file.isDirectory || !file.content) continue;
    const lowerPath = file.path.toLowerCase();
    const isJsOrTs = /\.(js|mjs|cjs|ts|mts|cts)$/.test(lowerPath);
    const isPy = lowerPath.endsWith('.py');
    if (!isJsOrTs && !isPy) continue;

    const src = file.content;

    if (isJsOrTs) {
      const listenerMatches = src.match(/interactionCreate/g);
      if (listenerMatches) {
        interactionListenerCount += listenerMatches.length;
      }

      if (/interactionCreate/.test(src) && !/deferReply|deferUpdate/.test(src)) {
        findings.push({
          file: file.path,
          severity: 'warn',
          message:
            'Slash handler does not explicitly call deferReply() — FACON Runtime Shield will auto-defer at 1.8s, but calling await interaction.deferReply() before DB/API work is recommended.',
        });
      }

      if (/readFileSync|writeFileSync|execSync/.test(src) && /interactionCreate/.test(src)) {
        findings.push({
          file: file.path,
          severity: 'warn',
          message:
            'Synchronous blocking fs/execSync calls inside interaction handler file can block the Node.js event loop past Discord 3s timeout.',
        });
      }
    }

    if (isPy) {
      if (/@[\w.]*tree\.command|@app_commands\.command/.test(src) && !/response\.defer/.test(src)) {
        findings.push({
          file: file.path,
          severity: 'warn',
          message:
            'Slash commands do not call interaction.response.defer() explicitly — FACON Runtime Shield will auto-defer at 1.8s and route followups safely.',
        });
      }

      if (/\brequests\.(get|post|put|delete)\b|\btime\.sleep\s*\(/.test(src)) {
        findings.push({
          file: file.path,
          severity: 'warn',
          message:
            'Blocking synchronous I/O (requests.* or time.sleep) detected in Python bot; prefer aiohttp/asyncio.sleep so the Discord event loop stays responsive.',
        });
      }

      if (/response\.send_message/.test(src) && /response\.defer/.test(src) && !/followup\.send/.test(src)) {
        findings.push({
          file: file.path,
          severity: 'warn',
          message:
            'File uses both response.defer() and response.send_message() without followup.send() — FACON Shield automatically routes deferred sends to followup.send().',
        });
      }
    }
  }

  if (interactionListenerCount > 2) {
    findings.push({
      file: 'workspace',
      severity: 'warn',
      message: `Detected ${interactionListenerCount} interactionCreate references across workspace — FACON Shield guards against duplicate listeners and 40060 double-reply errors.`,
    });
  }

  return findings;
}
