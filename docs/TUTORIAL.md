# Complete Beginner Tutorial: Getting Started with mlx-serving

**Level**: Beginner
**Time**: 30-45 minutes
**Goal**: Build your first AI-powered application using mlx-serving

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Installation](#installation)
3. [Your First Text Generation](#your-first-text-generation)
4. [Understanding the API](#understanding-the-api)
5. [Building a Simple Chatbot](#building-a-simple-chatbot)
6. [Working with Vision Models](#working-with-vision-models)
7. [Building a Complete App](#building-a-complete-app)
8. [Next Steps](#next-steps)

---

## Prerequisites

Before starting, make sure you have:

1. **macOS with Apple Silicon** (M1, M2, M3, or M4)
2. **Node.js 18+** installed
   ```bash
   node --version  # Should show v18 or higher
   ```
3. **Basic TypeScript/JavaScript knowledge** (variables, functions, async/await)
4. **A code editor** (VS Code recommended)

**Hardware Requirements**:
- Minimum: 16 GB RAM
- Recommended: 32 GB+ RAM
- Storage: 10-50 GB free (for models)

---

## Installation

### Step 1: Create a New Project

```bash
# Create project directory
mkdir my-first-ai-app
cd my-first-ai-app

# Initialize Node.js project
npm init -y
```

### Step 2: Install mlx-serving

```bash
npm install @defai.digital/mlx-serving
```

This will:
- Install the mlx-serving package
- Automatically set up the Python environment (takes 2-3 minutes)
- Install MLX and required dependencies

**Wait for the installation to complete** - you'll see "Python environment configured successfully"

### Step 3: Set Up TypeScript

```bash
npm install -D typescript tsx @types/node
npx tsc --init
```

Edit `tsconfig.json` to enable ES modules:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true
  }
}
```

Update `package.json` to use ES modules:

```json
{
  "type": "module",
  "scripts": {
    "start": "tsx src/index.ts"
  }
}
```

### Step 4: Create Project Structure

```bash
mkdir src
```

---

## Your First Text Generation

### Step 1: Create Your First File

Create `src/hello-ai.ts`:

```typescript
import { createEngine } from '@defai.digital/mlx-serving';

async function main() {
  console.log('🚀 Starting mlx-serving...\n');

  // Create the engine
  const engine = await createEngine();
  console.log('✅ Engine created!\n');

  // Load a small, fast model (3B parameters)
  console.log('📦 Loading model (this may take 1-2 minutes on first run)...');
  await engine.loadModel({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'
  });
  console.log('✅ Model loaded!\n');

  // Generate text
  console.log('🤖 AI Response:');
  for await (const chunk of engine.createGenerator({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt: 'What is the capital of France?',
    maxTokens: 100
  })) {
    if (chunk.type === 'token') {
      process.stdout.write(chunk.token);
    }
  }

  console.log('\n\n✅ Done!');
  await engine.shutdown();
}

main().catch(console.error);
```

### Step 2: Run It!

```bash
npx tsx src/hello-ai.ts
```

**Expected Output**:
```
🚀 Starting mlx-serving...

✅ Engine created!

📦 Loading model (this may take 1-2 minutes on first run)...
✅ Model loaded!

🤖 AI Response:
The capital of France is Paris.

✅ Done!
```

**Congratulations!** You just ran your first AI model locally on your Mac!

---

## Understanding the API

Let's break down what we just did:

### 1. Create the Engine

```typescript
const engine = await createEngine();
```

This creates an engine instance that manages:
- Python runtime
- Model loading/unloading
- Memory management
- GPU acceleration

### 2. Load a Model

```typescript
await engine.loadModel({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'
});
```

**Model Format**: `mlx-community/<model-name>-4bit`
- Downloads from Hugging Face (cached after first download)
- 4-bit quantization = smaller size, faster inference
- First load takes 1-2 minutes, subsequent loads are instant

**Popular Models**:
- `Llama-3.2-3B-Instruct-4bit` (2GB) - Fast, great for testing
- `Qwen2.5-7B-Instruct-4bit` (4GB) - Better quality
- `Qwen2.5-14B-Instruct-4bit` (8GB) - High quality

### 3. Generate Text (Streaming)

```typescript
for await (const chunk of engine.createGenerator({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  prompt: 'Your question here',
  maxTokens: 100
})) {
  if (chunk.type === 'token') {
    process.stdout.write(chunk.token);
  }
}
```

**Why Streaming?**
- See results as they're generated (like ChatGPT)
- Better user experience
- Can cancel mid-generation

### 4. Generate Text (Non-Streaming)

For complete responses all at once:

```typescript
const response = await engine.generate({
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  prompt: 'Your question here',
  maxTokens: 100
});

console.log(response); // Complete string
```

### 5. Clean Up

```typescript
await engine.shutdown();
```

Always call this when done to clean up resources.

---

## Building a Simple Chatbot

Let's build an interactive chatbot!

Create `src/chatbot.ts`:

```typescript
import { createEngine } from '@defai.digital/mlx-serving';
import * as readline from 'readline';

async function main() {
  console.log('🤖 Starting Chatbot...\n');

  // Create engine and load model
  const engine = await createEngine();
  await engine.loadModel({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'
  });

  console.log('✅ Chatbot ready! Type "exit" to quit.\n');

  // Create readline interface
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  // Chat loop
  while (true) {
    // Get user input
    const question = await new Promise<string>((resolve) => {
      rl.question('You: ', resolve);
    });

    // Check for exit
    if (question.toLowerCase() === 'exit') {
      console.log('\n👋 Goodbye!');
      break;
    }

    // Generate response
    process.stdout.write('AI: ');
    for await (const chunk of engine.createGenerator({
      model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
      prompt: question,
      maxTokens: 200,
      temperature: 0.7
    })) {
      if (chunk.type === 'token') {
        process.stdout.write(chunk.token);
      }
    }
    console.log('\n');
  }

  rl.close();
  await engine.shutdown();
}

main().catch(console.error);
```

**Run it**:
```bash
npx tsx src/chatbot.ts
```

**Try asking**:
- "What is TypeScript?"
- "Explain recursion in simple terms"
- "Write a haiku about coding"

---

## Working with Vision Models

Now let's add vision capabilities!

### Step 1: Download Test Image

```bash
curl -o test-image.jpg "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3a/Cat03.jpg/300px-Cat03.jpg"
```

### Step 2: Create Vision Script

Create `src/vision-demo.ts`:

```typescript
import { createEngine } from '@defai.digital/mlx-serving';
import { readFileSync } from 'fs';

async function main() {
  console.log('👁️  Starting Vision Demo...\n');

  const engine = await createEngine();

  // Load a vision model
  console.log('📦 Loading Qwen3-VL-4B (this is a vision model)...');
  await engine.loadModel({
    model: 'mlx-community/Qwen3-VL-4B-Instruct-4bit'
  });
  console.log('✅ Model loaded!\n');

  // Read image
  const imageBuffer = readFileSync('test-image.jpg');
  const imageBase64 = imageBuffer.toString('base64');

  // Analyze image
  console.log('🤖 Analyzing image...\n');
  console.log('AI: ');
  for await (const chunk of engine.createGenerator({
    model: 'mlx-community/Qwen3-VL-4B-Instruct-4bit',
    prompt: 'Describe this image in detail.',
    images: [`data:image/jpeg;base64,${imageBase64}`],
    maxTokens: 300
  })) {
    if (chunk.type === 'token') {
      process.stdout.write(chunk.token);
    }
  }

  console.log('\n\n✅ Done!');
  await engine.shutdown();
}

main().catch(console.error);
```

**Run it**:
```bash
npx tsx src/vision-demo.ts
```

---

## Building a Complete App

Let's build a simple image description service!

Create `src/image-describer.ts`:

```typescript
import { createEngine } from '@defai.digital/mlx-serving';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function describeImages(imagePaths: string[]) {
  console.log('🚀 Image Describer Starting...\n');

  const engine = await createEngine();

  console.log('📦 Loading Qwen3-VL-4B...');
  await engine.loadModel({
    model: 'mlx-community/Qwen3-VL-4B-Instruct-4bit'
  });
  console.log('✅ Model ready!\n');

  const results: Array<{ path: string; description: string }> = [];

  for (const imagePath of imagePaths) {
    console.log(`\n📸 Processing: ${imagePath}`);
    console.log('─'.repeat(60));

    try {
      // Read and encode image
      const imageBuffer = readFileSync(imagePath);
      const imageBase64 = imageBuffer.toString('base64');

      // Generate description
      let description = '';
      for await (const chunk of engine.createGenerator({
        model: 'mlx-community/Qwen3-VL-4B-Instruct-4bit',
        prompt: `Describe this image concisely. Focus on:
- Main subject
- Colors and composition
- Notable details
- Overall mood`,
        images: [`data:image/jpeg;base64,${imageBase64}`],
        maxTokens: 200,
        temperature: 0.7
      })) {
        if (chunk.type === 'token') {
          description += chunk.token;
          process.stdout.write(chunk.token);
        }
      }

      results.push({ path: imagePath, description: description.trim() });
      console.log('\n');
    } catch (error) {
      console.error(`❌ Error processing ${imagePath}:`, error);
    }
  }

  await engine.shutdown();

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 SUMMARY');
  console.log('='.repeat(60));
  results.forEach((result, i) => {
    console.log(`\n${i + 1}. ${result.path}`);
    console.log(`   ${result.description.slice(0, 100)}...`);
  });

  return results;
}

// Usage
const imageFiles = process.argv.slice(2);

if (imageFiles.length === 0) {
  console.log('Usage: npx tsx src/image-describer.ts <image1.jpg> [image2.jpg] ...');
  process.exit(1);
}

describeImages(imageFiles).catch(console.error);
```

**Run it**:
```bash
npx tsx src/image-describer.ts test-image.jpg
```

**Or process multiple images**:
```bash
npx tsx src/image-describer.ts image1.jpg image2.jpg image3.jpg
```

---

## Next Steps

### 🎯 What You've Learned

1. ✅ Install and set up mlx-serving
2. ✅ Generate text with language models
3. ✅ Build an interactive chatbot
4. ✅ Use vision models to analyze images
5. ✅ Create a complete application

### 🚀 Where to Go Next

**1. Explore More Models**

Try different models for different tasks:

```typescript
// Best for coding
await engine.loadModel({
  model: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit'
});

// Best for general chat
await engine.loadModel({
  model: 'mlx-community/Qwen2.5-7B-Instruct-4bit'
});

// Best for vision tasks
await engine.loadModel({
  model: 'mlx-community/Qwen3-VL-8B-Instruct-4bit'
});
```

**2. Add Advanced Features**

- **System Prompts**: Guide model behavior
  ```typescript
  const generator = engine.createGenerator({
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    prompt: 'Explain quantum computing',
    systemPrompt: 'You are a helpful physics teacher explaining concepts to high school students.'
  });
  ```

- **Temperature Control**: Adjust creativity
  ```typescript
  temperature: 0.1  // More focused, deterministic
  temperature: 0.7  // Balanced (default)
  temperature: 1.5  // More creative, random
  ```

- **Stop Sequences**: Control when to stop
  ```typescript
  stopSequences: ['\n\n', 'END']
  ```

**3. Build Real Applications**

Ideas for your next project:
- 📝 Blog post generator
- 🔍 Document Q&A system
- 🎨 Image caption generator for photo library
- 💬 Customer service chatbot
- 📊 Data analysis assistant
- 🌐 Multi-language translator

**4. Optimize Performance**

- Use smaller models for faster responses
- Implement caching for repeated queries
- Batch process multiple requests
- See [PERFORMANCE.md](./PERFORMANCE.md) for advanced optimization

**5. Production Deployment**

When ready for production:
- Add error handling and retry logic
- Implement rate limiting
- Monitor memory usage
- Set up logging
- See [DEPLOYMENT.md](./DEPLOYMENT.md) for deployment guide

### 📚 Additional Resources

- **[GUIDES.md](./GUIDES.md)** - Comprehensive feature guide
- **[QUICK_START.md](./QUICK_START.md)** - 5-minute quick start
- **[PERFORMANCE.md](./PERFORMANCE.md)** - Performance optimization
- **[API Reference](../README.md#api-reference)** - Complete API documentation
- **[Examples](../examples/)** - More code examples

### 💡 Tips for Success

1. **Start Small**: Begin with 3B-7B models while learning
2. **Use Streaming**: Better UX than waiting for complete response
3. **Handle Errors**: Always wrap in try-catch blocks
4. **Clean Up**: Always call `engine.shutdown()` when done
5. **Monitor Memory**: Use Activity Monitor to check RAM usage
6. **Cache Models**: Models are cached after first download

### 🆘 Getting Help

- **Issues**: [GitHub Issues](https://github.com/defai-digital/mlx-serving/issues)
- **Discussions**: [GitHub Discussions](https://github.com/defai-digital/mlx-serving/discussions)
- **Documentation**: [docs.claude.com](https://docs.claude.com/en/docs/claude-code)

---

## Troubleshooting

### Common Issues

**1. "Python environment not found"**
```bash
# Re-run postinstall
npm run postinstall
```

**2. "Model not found"**
- Check model name spelling
- Ensure internet connection (first download)
- Try a different model

**3. "Out of memory"**
- Use smaller model (3B instead of 7B)
- Close other applications
- Restart your Mac

**4. Slow performance**
- First run always slower (model download)
- Subsequent runs are fast (cached)
- Use smaller models for faster inference

**5. "Module not found" errors**
```bash
# Ensure package.json has "type": "module"
# Check tsconfig.json moduleResolution is "node"
```

---

**Congratulations!** You've completed the mlx-serving beginner tutorial. You're now ready to build amazing AI applications on your Mac!

**Happy coding! 🚀**
