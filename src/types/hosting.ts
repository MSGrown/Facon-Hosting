export type SupportedRuntime =
  | 'Python'
  | 'Java'
  | 'Node.js'
  | 'JavaScript'
  | 'TypeScript'
  | 'C'
  | 'C++'
  | 'Go'
  | 'Rust';

export type SupportedAppType =
  | 'Discord Bot'
  | 'Telegram Bot'
  | 'WhatsApp Bot'
  | 'Custom Application';

export type NodeRegion = 'us-east-1' | 'eu-central-1' | 'ap-southeast-1';

export type ServerStatus = 'running' | 'stopped' | 'starting' | 'restarting' | 'suspended';

export type AppPage =
  | 'home'
  | 'login'
  | 'register'
  | 'dashboard'
  | 'servers'
  | 'create-server'
  | 'console'
  | 'files'
  | 'startup'
  | 'backups'
  | 'settings'
  | 'admin';

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL?: string;
  role: 'user' | 'admin';
  plan: 'FREE';
  suspended: boolean;
  serverLimit: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface BotServer {
  id: string;
  ownerId: string;
  ownerEmail: string;
  name: string;
  runtime: SupportedRuntime;
  appType: SupportedAppType;
  nodeRegion: NodeRegion;
  status: ServerStatus;
  startupCommand: string;
  autoRestart: boolean;
  plan: 'FREE';
  ramLimitMb: number;
  cpuLimitPct: number;
  diskLimitMb: number;
  bandwidthMbps: number;
  backupLimit: number;
  cpuUsage: number;
  ramUsageMb: number;
  diskUsageMb: number;
  networkMbps: number;
  uptimeSeconds: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ServerFile {
  id: string;
  name: string;
  path: string;
  sizeBytes: number;
  mimeType: string;
  content: string;
  isDirectory: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ServerEnvVar {
  id: string;
  key: string;
  value: string;
  isSecret: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface ServerBackup {
  id: string;
  name: string;
  note: string;
  sizeMb: number;
  fileCount: number;
  status: 'completed' | 'creating' | 'restoring';
  createdAt?: unknown;
}

export interface ServerLog {
  id: string;
  level: 'info' | 'warn' | 'error' | 'cmd' | 'system';
  message: string;
  createdAt?: unknown;
}

export const FREE_PLAN_SPECS = {
  name: 'Free Cloud Node',
  priceLabel: 'FREE',
  ramLabel: '20 GB',
  ramMb: 20480,
  cpuLabel: '500%',
  cpuPct: 500,
  diskLabel: '20 GB',
  diskMb: 20480,
  bandwidthLabel: '500 Mbps',
  bandwidthMbps: 500,
  backupsLabel: '5',
  backupsLimit: 5,
  maxServersPerUser: 10,
} as const;

export const SUPPORTED_RUNTIMES: {
  id: SupportedRuntime;
  version: string;
  defaultCmd: string;
  entryFile: string;
  summary: string;
}[] = [
  {
    id: 'Python',
    version: '3.12 LTS',
    defaultCmd: 'python3 -u main.py',
    entryFile: 'main.py',
    summary: 'Asyncio, discord.py, python-telegram-bot, FastAPI workers',
  },
  {
    id: 'Node.js',
    version: '22 LTS',
    defaultCmd: 'node --enable-source-maps index.js',
    entryFile: 'index.js',
    summary: 'discord.js, Baileys WhatsApp, Telegraf, Express services',
  },
  {
    id: 'TypeScript',
    version: '5.7 / tsx',
    defaultCmd: 'npx tsx src/index.ts',
    entryFile: 'src/index.ts',
    summary: 'Strict typed bots with zero-config runtime execution',
  },
  {
    id: 'JavaScript',
    version: 'ES2024',
    defaultCmd: 'node app.mjs',
    entryFile: 'app.mjs',
    summary: 'Lightweight ESM automation scripts and webhook relays',
  },
  {
    id: 'Java',
    version: 'JDK 21 LTS',
    defaultCmd: 'java -Xms256m -Xmx16384m -jar bot.jar',
    entryFile: 'Main.java',
    summary: 'JDA, Javacord, Spring Boot microservices',
  },
  {
    id: 'Go',
    version: '1.23',
    defaultCmd: 'go run ./cmd/bot',
    entryFile: 'main.go',
    summary: 'Low-memory discordgo & high-throughput bot workers',
  },
  {
    id: 'Rust',
    version: '1.82',
    defaultCmd: 'cargo run --release',
    entryFile: 'src/main.rs',
    summary: 'Serenity, Poise, Teloxide ultra-low-latency binaries',
  },
  {
    id: 'C++',
    version: 'GCC 14 / C++20',
    defaultCmd: 'g++ -O2 main.cpp -o bot && ./bot',
    entryFile: 'main.cpp',
    summary: 'DPP (D++), tdlib, high-frequency socket engines',
  },
  {
    id: 'C',
    version: 'GCC 14 / C17',
    defaultCmd: 'gcc -O2 main.c -o bot && ./bot',
    entryFile: 'main.c',
    summary: 'Minimal footprint libcurl & POSIX daemon processes',
  },
];

export const SUPPORTED_APPLICATIONS: {
  id: SupportedAppType;
  description: string;
  recommendedRuntimes: SupportedRuntime[];
  defaultEnvKey: string;
}[] = [
  {
    id: 'Discord Bot',
    description: '24/7 gateway shard workers, slash commands, moderation & music pipelines.',
    recommendedRuntimes: ['Node.js', 'Python', 'TypeScript', 'Rust', 'Java'],
    defaultEnvKey: 'DISCORD_TOKEN',
  },
  {
    id: 'Telegram Bot',
    description: 'Long-polling or webhook handlers for groups, payments, and inline bots.',
    recommendedRuntimes: ['Python', 'Go', 'Node.js', 'TypeScript'],
    defaultEnvKey: 'TELEGRAM_BOT_TOKEN',
  },
  {
    id: 'WhatsApp Bot',
    description: 'Multi-device session listeners, automated responders, and media relays.',
    recommendedRuntimes: ['Node.js', 'TypeScript', 'Python', 'Go'],
    defaultEnvKey: 'WHATSAPP_SESSION_KEY',
  },
  {
    id: 'Custom Application',
    description: 'Background daemons, cron workers, API relays, and compiled CLI services.',
    recommendedRuntimes: ['Go', 'Rust', 'C++', 'C', 'Python', 'Java'],
    defaultEnvKey: 'APP_SECRET_KEY',
  },
];

export const NODE_REGIONS: { id: NodeRegion; label: string; location: string }[] = [
  { id: 'us-east-1', label: 'US East · Virginia', location: 'Ashburn, USA' },
  { id: 'eu-central-1', label: 'EU Central · Frankfurt', location: 'Frankfurt, DE' },
  { id: 'ap-southeast-1', label: 'AP Southeast · Singapore', location: 'Singapore, SG' },
];

export const ADMIN_BOOTSTRAPPED_EMAIL = 'sadhikmohammad292@gmail.com';

const JS_DISCORD_STARTER = (serverName: string) => `import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token || token === 'replace_with_your_token') {
  console.error('[CONFIG] Set your real DISCORD_TOKEN in Startup -> Environment Variables, then Restart.');
  process.exit(1);
}

process.on('unhandledRejection', (err) => {
  console.error('[ASYNC ERROR]', err instanceof Error ? err.stack || err.message : err);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

async function safeRespond(interaction, payload) {
  const normalized = typeof payload === 'string' ? { content: payload } : payload;
  if (interaction.deferred && !interaction.replied) {
    const editOpts = { ...normalized };
    delete editOpts.ephemeral;
    delete editOpts.flags;
    return interaction.editReply(editOpts);
  }
  if (interaction.replied) {
    return interaction.followUp(normalized);
  }
  return interaction.reply(normalized);
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(\`Logged in as \${readyClient.user.tag} (\${readyClient.guilds.cache.size} guilds)\`);
  try {
    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(readyClient.user.id), {
      body: [new SlashCommandBuilder().setName('ping').setDescription('Check bot latency').toJSON()],
    });
  } catch (err) {
    console.warn('[SLASH SYNC WARN]', err instanceof Error ? err.message : err);
  }
});

client.on(Events.Error, (err) => {
  console.error('[CLIENT ERROR]', err.message);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  try {
    if (message.content.trim() === '!ping') {
      await message.reply(\`Pong! Gateway ping: \${Math.round(client.ws.ping)}ms\`);
    }
  } catch (err) {
    console.error('[MESSAGE COMMAND ERROR]', err instanceof Error ? err.message : err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === 'ping') {
      await safeRespond(interaction, { content: \`Pong! \${Math.round(client.ws.ping)}ms\` });
    } else {
      await safeRespond(interaction, { content: \`Unknown command /\${interaction.commandName}\` });
    }
  } catch (err) {
    console.error('[INTERACTION ERROR]', err instanceof Error ? err.stack || err.message : err);
    await safeRespond(interaction, { content: 'Command execution error.', flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

console.log('[FACON HOST] Connecting ${serverName} to Discord Gateway...');
client.login(token).catch((err) => {
  console.error('[GATEWAY ERROR]', err?.message || err);
  process.exit(1);
});
`;

const PY_DISCORD_STARTER = (serverName: string) => `import os
import sys
import traceback
import discord
from discord import app_commands
from discord.ext import commands

TOKEN = (os.getenv("DISCORD_TOKEN") or "").strip()
if not TOKEN or TOKEN == "replace_with_your_token":
    print("[CONFIG] Set DISCORD_TOKEN in Startup -> Environment Variables, then Restart.", file=sys.stderr)
    sys.exit(1)

intents = discord.Intents.default()
intents.message_content = True

bot = commands.Bot(command_prefix="!", intents=intents)

async def safe_reply(interaction: discord.Interaction, **kwargs):
    if interaction.response.is_done():
        return await interaction.followup.send(**kwargs)
    return await interaction.response.send_message(**kwargs)

@bot.event
async def on_ready():
    print(f"Logged in as {bot.user} ({len(bot.guilds)} guilds)")
    try:
        synced = await bot.tree.sync()
        print(f"[SLASH SYNC] Synced {len(synced)} application command(s).")
    except Exception as exc:
        print(f"[SLASH SYNC WARN] {exc}", file=sys.stderr)

@bot.tree.error
async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError):
    print(f"[SLASH ERROR] /{interaction.command.name if interaction.command else 'unknown'}: {error}", file=sys.stderr)
    traceback.print_exception(type(error), error, error.__traceback__, file=sys.stderr)
    await safe_reply(interaction, content=f"Command failed: {error}", ephemeral=True)

@bot.event
async def on_command_error(ctx: commands.Context, error: commands.CommandError):
    if isinstance(error, commands.CommandNotFound):
        return
    print(f"[COMMAND ERROR] {error}", file=sys.stderr)

@bot.tree.command(name="ping", description="Check bot gateway latency")
async def slash_ping(interaction: discord.Interaction):
    await interaction.response.defer(thinking=True, ephemeral=True)
    await safe_reply(interaction, content=f"Pong! Latency: {round(bot.latency * 1000)}ms")

@bot.command(name="ping")
async def ping_cmd(ctx: commands.Context):
    await ctx.reply(f"Pong! Latency: {round(bot.latency * 1000)}ms")

print("[FACON HOST] Connecting ${serverName} to Discord Gateway...")
bot.run(TOKEN)
`;

export function buildStarterFiles(runtime: SupportedRuntime, appType: SupportedAppType, serverName: string) {
  const safeName = serverName.toLowerCase().replace(/[^a-z0-9-_]/g, '-') || 'facon-bot';
  const readmeContent = `# ${serverName}\n\nHosted on FACON HOST Free Cloud Node\n- Application: ${appType}\n- Runtime: ${runtime}\n- Plan: FREE (20 GB RAM / 500% CPU / 20 GB Disk / 500 Mbps / 5 Backups)\n`;

  switch (runtime) {
    case 'Python':
      return [
        {
          name: 'main.py',
          path: '/main.py',
          mimeType: 'text/x-python',
          content:
            appType === 'Discord Bot'
              ? PY_DISCORD_STARTER(serverName)
              : `import os\nimport time\n\nAPP_TYPE = "${appType}"\nSERVER_NAME = "${serverName}"\nENV_KEY = "${appType === 'Telegram Bot' ? 'TELEGRAM_BOT_TOKEN' : 'APP_SECRET_KEY'}"\n\ndef main():\n    print(f"[FACON HOST] Booting {SERVER_NAME} ({APP_TYPE}) on Python 3.12")\n    token = os.getenv(ENV_KEY, "")\n    if not token or token == "replace_with_your_token":\n        print(f"Configure {ENV_KEY} in Startup -> Environment Variables before connecting.")\n    else:\n        print(f"Loaded {ENV_KEY} ({len(token)} chars)")\n    while True:\n        time.sleep(60)\n\nif __name__ == "__main__":\n    main()\n`,
        },
        {
          name: 'requirements.txt',
          path: '/requirements.txt',
          mimeType: 'text/plain',
          content:
            appType === 'Discord Bot'
              ? 'discord.py>=2.4.0\npython-dotenv>=1.0.1\naiohttp>=3.10.0\n'
              : appType === 'Telegram Bot'
              ? 'python-telegram-bot>=21.6\npython-dotenv>=1.0.1\n'
              : 'python-dotenv>=1.0.1\nrequests>=2.32.3\n',
        },
        { name: 'README.md', path: '/README.md', mimeType: 'text/markdown', content: readmeContent },
      ];
    case 'TypeScript':
      return [
        {
          name: 'index.ts',
          path: '/src/index.ts',
          mimeType: 'text/typescript',
          content:
            appType === 'Discord Bot'
              ? JS_DISCORD_STARTER(serverName)
              : `const appType = "${appType}";\nconst serverName = "${serverName}";\n\nasync function bootstrap(): Promise<void> {\n  console.log(\`[FACON HOST] Starting \${serverName} (\${appType}) on TypeScript · 20 GB RAM allocated\`);\n  setInterval(() => {\n    console.log("[HEARTBEAT] Worker healthy");\n  }, 60000);\n}\n\nbootstrap().catch(console.error);\n`,
        },
        {
          name: 'package.json',
          path: '/package.json',
          mimeType: 'application/json',
          content: JSON.stringify(
            {
              name: safeName,
              version: '1.0.0',
              type: 'module',
              scripts: { start: 'tsx src/index.ts' },
              dependencies:
                appType === 'Discord Bot'
                  ? { 'discord.js': '^14.16.3', tsx: '^4.19.0', dotenv: '^16.4.5' }
                  : { tsx: '^4.19.0', dotenv: '^16.4.5' },
            },
            null,
            2
          ),
        },
        { name: 'README.md', path: '/README.md', mimeType: 'text/markdown', content: readmeContent },
      ];
    case 'Node.js':
    case 'JavaScript':
      return [
        {
          name: runtime === 'JavaScript' ? 'app.mjs' : 'index.js',
          path: runtime === 'JavaScript' ? '/app.mjs' : '/index.js',
          mimeType: 'application/javascript',
          content:
            appType === 'Discord Bot'
              ? JS_DISCORD_STARTER(serverName)
              : `console.log("[FACON HOST] Booting ${serverName} (${appType}) on ${runtime}");\n\nsetInterval(() => {\n  console.log("[WORKER] Active event loop · 20 GB RAM allocated");\n}, 60000);\n`,
        },
        {
          name: 'package.json',
          path: '/package.json',
          mimeType: 'application/json',
          content: JSON.stringify(
            {
              name: safeName,
              version: '1.0.0',
              type: 'module',
              scripts: { start: runtime === 'JavaScript' ? 'node app.mjs' : 'node index.js' },
              dependencies: appType === 'Discord Bot' ? { 'discord.js': '^14.16.3' } : {},
            },
            null,
            2
          ),
        },
        { name: 'README.md', path: '/README.md', mimeType: 'text/markdown', content: readmeContent },
      ];
    case 'Java':
      return [
        {
          name: 'Main.java',
          path: '/src/Main.java',
          mimeType: 'text/x-java-source',
          content: `public class Main {\n    public static void main(String[] args) {\n        System.out.println("[FACON HOST] Booting ${serverName} (${appType}) on JDK 21");\n    }\n}\n`,
        },
        { name: 'README.md', path: '/README.md', mimeType: 'text/markdown', content: readmeContent },
      ];
    case 'Go':
      return [
        {
          name: 'main.go',
          path: '/cmd/bot/main.go',
          mimeType: 'text/x-go',
          content: `package main\n\nimport (\n\t"fmt"\n\t"time"\n)\n\nfunc main() {\n\tfmt.Println("[FACON HOST] Booting ${serverName} (${appType}) on Go 1.23")\n\tfor {\n\t\ttime.Sleep(60 * time.Second)\n\t}\n}\n`,
        },
        {
          name: 'go.mod',
          path: '/go.mod',
          mimeType: 'text/plain',
          content: `module ${safeName}\n\ngo 1.23\n`,
        },
      ];
    case 'Rust':
      return [
        {
          name: 'main.rs',
          path: '/src/main.rs',
          mimeType: 'text/x-rustsrc',
          content: `fn main() {\n    println!("[FACON HOST] Booting ${serverName} (${appType}) on Rust 1.82");\n}\n`,
        },
        {
          name: 'Cargo.toml',
          path: '/Cargo.toml',
          mimeType: 'text/plain',
          content: `[package]\nname = "${safeName}"\nversion = "0.1.0"\nedition = "2021"\n`,
        },
      ];
    case 'C++':
      return [
        {
          name: 'main.cpp',
          path: '/main.cpp',
          mimeType: 'text/x-c++src',
          content: `#include <iostream>\n\nint main() {\n    std::cout << "[FACON HOST] Booting ${serverName} (${appType}) on C++20" << std::endl;\n    return 0;\n}\n`,
        },
        { name: 'README.md', path: '/README.md', mimeType: 'text/markdown', content: readmeContent },
      ];
    case 'C':
      return [
        {
          name: 'main.c',
          path: '/main.c',
          mimeType: 'text/x-csrc',
          content: `#include <stdio.h>\n\nint main(void) {\n    printf("[FACON HOST] Booting ${serverName} (${appType}) on C17\\n");\n    return 0;\n}\n`,
        },
        { name: 'README.md', path: '/README.md', mimeType: 'text/markdown', content: readmeContent },
      ];
  }
}
