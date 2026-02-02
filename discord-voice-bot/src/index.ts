#!/usr/bin/env node

import {
  Client,
  GatewayIntentBits,
  VoiceState,
  Message,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnection,
  getVoiceConnection,
  EndBehaviorType,
} from '@discordjs/voice';
import { createWriteStream, createReadStream, unlinkSync } from 'fs';
import { pipeline } from 'stream/promises';
import OpenAI from 'openai';
import { config } from 'dotenv';
import prism from 'prism-media';
import { OpusEncoder } from '@discordjs/opus';

config();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// Track active voice connections and recordings
const connections = new Map<string, VoiceConnection>();
const recordings = new Map<string, Map<string, NodeJS.WritableStream>>();
const audioPlayers = new Map<string, ReturnType<typeof createAudioPlayer>>();

/**
 * Convert PCM audio to WAV format (for Whisper API)
 */
function pcmToWav(pcmFile: string, wavFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('ffmpeg-static');
    const { spawn } = require('child_process');

    const process = spawn(ffmpeg, [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', pcmFile,
      wavFile
    ]);

    process.on('close', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    process.on('error', reject);
  });
}

/**
 * Transcribe audio using OpenAI Whisper
 */
async function transcribeAudio(audioFilePath: string): Promise<string> {
  try {
    const transcription = await openai.audio.transcriptions.create({
      file: createReadStream(audioFilePath),
      model: 'whisper-1',
      language: 'en',
    });

    return transcription.text;
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

/**
 * Generate speech using OpenAI TTS
 */
async function generateSpeech(text: string, outputPath: string): Promise<void> {
  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'alloy',
      input: text,
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    await require('fs').promises.writeFile(outputPath, buffer);
  } catch (error) {
    console.error('TTS error:', error);
    throw error;
  }
}

/**
 * Get AI response from Claude (via Anthropic API)
 */
async function getAIResponse(userMessage: string): Promise<string> {
  // If you want to use Claude instead of OpenAI, you can switch here
  // For now, using OpenAI for simplicity
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful voice assistant in a Discord server. Keep responses concise and conversational since they will be spoken aloud.',
        },
        {
          role: 'user',
          content: userMessage,
        },
      ],
      max_tokens: 150,
    });

    return completion.choices[0]?.message?.content || 'Sorry, I could not generate a response.';
  } catch (error) {
    console.error('AI response error:', error);
    return 'Sorry, I encountered an error processing your request.';
  }
}

/**
 * Play audio in voice channel
 */
async function playAudioInChannel(guildId: string, audioFilePath: string): Promise<void> {
  const connection = connections.get(guildId);
  if (!connection) {
    throw new Error('No voice connection found');
  }

  let player = audioPlayers.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    audioPlayers.set(guildId, player);
    connection.subscribe(player);
  }

  const resource = createAudioResource(audioFilePath);
  player.play(resource);

  return new Promise((resolve, reject) => {
    player!.once(AudioPlayerStatus.Idle, () => {
      resolve();
    });
    player!.once('error', reject);
  });
}

/**
 * Start recording a user's audio
 */
function startRecording(connection: VoiceConnection, userId: string, guildId: string): void {
  const receiver = connection.receiver;

  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1000, // 1 second of silence ends the recording
    },
  });

  const filename = `/tmp/discord-voice-${guildId}-${userId}-${Date.now()}.pcm`;
  const writeStream = createWriteStream(filename);

  // Store the stream
  if (!recordings.has(guildId)) {
    recordings.set(guildId, new Map());
  }
  recordings.get(guildId)!.set(userId, writeStream);

  // Decode opus to PCM
  const opusDecoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  audioStream.pipe(opusDecoder).pipe(writeStream);

  // When recording ends (after silence)
  audioStream.once('end', async () => {
    writeStream.end();
    recordings.get(guildId)?.delete(userId);

    // Wait a bit for file to be written
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      // Convert PCM to WAV
      const wavFilename = filename.replace('.pcm', '.wav');
      await pcmToWav(filename, wavFilename);

      // Transcribe
      console.log(`Transcribing audio for user ${userId}...`);
      const transcript = await transcribeAudio(wavFilename);
      console.log(`Transcript: ${transcript}`);

      if (transcript.trim().length > 0) {
        // Get AI response
        console.log('Generating AI response...');
        const aiResponse = await getAIResponse(transcript);
        console.log(`AI Response: ${aiResponse}`);

        // Generate speech
        const responseAudioPath = `/tmp/discord-voice-response-${guildId}-${Date.now()}.mp3`;
        await generateSpeech(aiResponse, responseAudioPath);

        // Play response
        await playAudioInChannel(guildId, responseAudioPath);

        // Cleanup
        unlinkSync(responseAudioPath);
      }

      // Cleanup temp files
      unlinkSync(filename);
      unlinkSync(wavFilename);
    } catch (error) {
      console.error('Error processing audio:', error);
    }
  });
}

/**
 * Join a voice channel
 */
function joinChannel(channelId: string, guildId: string, adapterCreator: any): VoiceConnection {
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connections.set(guildId, connection);

  // Start listening to all users
  connection.receiver.speaking.on('start', (userId) => {
    console.log(`User ${userId} started speaking`);
    startRecording(connection, userId, guildId);
  });

  return connection;
}

/**
 * Leave voice channel
 */
function leaveChannel(guildId: string): void {
  const connection = connections.get(guildId);
  if (connection) {
    connection.destroy();
    connections.delete(guildId);
    audioPlayers.delete(guildId);
    recordings.delete(guildId);
  }
}

// Bot ready event
client.once('ready', () => {
  console.log(`Voice bot logged in as ${client.user?.tag}`);
  console.log('Commands:');
  console.log('  !join - Join your current voice channel');
  console.log('  !leave - Leave the voice channel');
  console.log('  !say <text> - Speak text in voice channel');
});

// Message handler for commands
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).split(' ');
  const command = args[0].toLowerCase();

  if (command === 'join') {
    const member = message.guild?.members.cache.get(message.author.id);
    const voiceChannel = member?.voice.channel;

    if (!voiceChannel) {
      await message.reply('You need to be in a voice channel first!');
      return;
    }

    try {
      joinChannel(
        voiceChannel.id,
        message.guild!.id,
        message.guild!.voiceAdapterCreator
      );
      await message.reply(`Joined ${voiceChannel.name}! Start speaking and I'll respond.`);
    } catch (error) {
      console.error('Error joining channel:', error);
      await message.reply('Failed to join voice channel.');
    }
  }

  if (command === 'leave') {
    leaveChannel(message.guild!.id);
    await message.reply('Left the voice channel.');
  }

  if (command === 'say') {
    const text = args.slice(1).join(' ');
    if (!text) {
      await message.reply('Please provide text to say!');
      return;
    }

    try {
      const audioPath = `/tmp/discord-voice-say-${Date.now()}.mp3`;
      await generateSpeech(text, audioPath);
      await playAudioInChannel(message.guild!.id, audioPath);
      unlinkSync(audioPath);
      await message.reply('✅ Spoken!');
    } catch (error) {
      console.error('Error speaking:', error);
      await message.reply('Failed to speak in voice channel.');
    }
  }
});

// Error handling
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

// Login
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN not found in environment');
  process.exit(1);
}

client.login(token);
