let audioContext = null;
let mediaStream = null;
let mediaRecorder;
let ws;
let isRecording = false;
let scriptProcessor = null;
let resamplerNode;

const toggleButton = document.getElementById('toggleButton');
const processButton = document.getElementById('processButton');
const status = document.getElementById('status');
const transcriptionArea = document.getElementById('transcription');
const processedTranscriptionArea = document.getElementById('processedTranscription');
const originalWordCount = document.getElementById('originalWordCount');
const processedWordCount = document.getElementById('processedWordCount');

// Audio configuration
const SAMPLE_RATE = 16000;
const DEFAULT_SAMPLE_RATE = 44100;
const DOWNSAMPLE_FACTOR = Math.floor(DEFAULT_SAMPLE_RATE / SAMPLE_RATE);

// Convert Float32Array to Int16Array
function float32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Array;
}

// Downsample audio data
function downsampleAudio(audioData) {
    const downsampledLength = Math.floor(audioData.length / DOWNSAMPLE_FACTOR);
    const downsampledData = new Float32Array(downsampledLength);
    
    for (let i = 0; i < downsampledLength; i++) {
        let sum = 0;
        for (let j = 0; j < DOWNSAMPLE_FACTOR; j++) {
            sum += audioData[i * DOWNSAMPLE_FACTOR + j];
        }
        downsampledData[i] = sum / DOWNSAMPLE_FACTOR;
    }
    
    return float32ToInt16(downsampledData);
}

// Keep track of transcriptions
let transcriptionHistory = [];
let currentPartialText = '';

// Update word count for a textarea
function updateWordCount(text, countElement) {
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    countElement.textContent = `Words: ${words}`;
}

// Initialize WebSocket connection
function initWebSocket() {
    ws = new WebSocket(`ws://${window.location.host}`);
    ws.binaryType = 'arraybuffer';
    
    ws.onopen = () => {
        status.textContent = 'Status: Connected to server';
    };

    ws.onclose = () => {
        status.textContent = 'Status: Disconnected from server';
        stopRecording();
    };

    ws.onerror = (error) => {
        status.textContent = 'Status: Error connecting to server';
        stopRecording();
    };

    ws.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'transcription':
                    if (message.isPartial) {
                        currentPartialText = message.text;
                    } else {
                        transcriptionHistory.push(message.text);
                        currentPartialText = '';
                        processButton.disabled = transcriptionHistory.length === 0;
                        transcriptionArea.disabled = false;
                    }
                    updateTranscriptionDisplay();
                    break;
                case 'processedTranscription':
                    processedTranscriptionArea.value = message.text;
                    processedTranscriptionArea.disabled = false;
                    processButton.disabled = false;
                    status.textContent = 'Status: Processing complete';
                    updateWordCount(message.text, processedWordCount);
                    break;
                case 'status':
                    status.textContent = `Status: ${message.message}`;
                    break;
                case 'error':
                    status.textContent = `Status: ${message.message}`;
                    processButton.disabled = false;
                    break;
            }
        } catch (error) {
            console.error('Message processing error:', error.message);
        }
    };
}

// Update the transcription display
function updateTranscriptionDisplay() {
    const finalText = transcriptionHistory.join(' ');
    const displayText = finalText + (currentPartialText ? ` ${currentPartialText}` : '');
    transcriptionArea.value = displayText;
    updateWordCount(displayText, originalWordCount);
}

// Process transcript with AI
function processTranscript() {
    if (!transcriptionArea.value.trim()) return;
    
    processButton.disabled = true;
    status.textContent = 'Status: Processing with AI...';
    processedTranscriptionArea.value = 'Processing...';
    processedTranscriptionArea.disabled = true;
    
    ws.send(JSON.stringify({
        type: 'processTranscript',
        text: transcriptionArea.value
    }));
}

// Clean up audio resources
async function cleanupAudio() {
    if (scriptProcessor) {
        scriptProcessor.disconnect();
        scriptProcessor = null;
    }
    
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
    
    if (audioContext && audioContext.state !== 'closed') {
        try {
            await audioContext.close();
        } catch (error) {
            console.warn('Error closing AudioContext:', error);
        }
        audioContext = null;
    }
}

// Stop recording
async function stopRecording() {
    if (!isRecording) return;
    
    isRecording = false;
    await cleanupAudio();
    
    toggleButton.textContent = 'Start Recording';
    toggleButton.classList.remove('recording');
    status.textContent = 'Status: Ready';
    processButton.disabled = !transcriptionArea.value.trim();
    transcriptionArea.disabled = false;
}

// Initialize audio context and start recording
async function startRecording() {
    if (isRecording) return;
    
    try {
        await cleanupAudio(); // Ensure cleanup before starting new recording
        
        // Create audio context without specifying sample rate
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        
        mediaStream = await navigator.mediaDevices.getUserMedia({ 
            audio: {
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });
        
        const source = audioContext.createMediaStreamSource(mediaStream);
        scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

        source.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);

        scriptProcessor.onaudioprocess = (e) => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                const inputData = e.inputBuffer.getChannelData(0);
                const processedData = downsampleAudio(inputData);
                ws.send(processedData.buffer);
            }
        };

        isRecording = true;
        toggleButton.textContent = 'Stop Recording';
        toggleButton.classList.add('recording');
        status.textContent = 'Status: Listening...';
        transcriptionArea.value = 'Listening...';
        transcriptionArea.disabled = true;
        processedTranscriptionArea.value = 'AI-processed text will appear here...';
        processedTranscriptionArea.disabled = true;
        transcriptionHistory = [];
        currentPartialText = '';
        processButton.disabled = true;
        updateWordCount('', originalWordCount);
        updateWordCount('', processedWordCount);
    } catch (error) {
        console.error('Recording error:', error.message);
        status.textContent = 'Status: Error starting recording';
        stopRecording();
    }
}

// Toggle recording state
async function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        await startRecording();
    }
}

// Event listeners
toggleButton.addEventListener('click', toggleRecording);
processButton.addEventListener('click', processTranscript);

// Listen for manual edits to update word count
transcriptionArea.addEventListener('input', () => {
    updateWordCount(transcriptionArea.value, originalWordCount);
    processButton.disabled = !transcriptionArea.value.trim();
});

processedTranscriptionArea.addEventListener('input', () => {
    updateWordCount(processedTranscriptionArea.value, processedWordCount);
});

// Initialize WebSocket when page loads
initWebSocket();