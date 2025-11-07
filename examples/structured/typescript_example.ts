/**
 * TypeScript Example - Type-safe structured output generation
 *
 * This example demonstrates how to use JSON schema with TypeScript
 * for fully type-safe model outputs.
 *
 * Requirements:
 * - kr-mlx-lm installed
 * - Python environment setup
 * - A loaded text model
 *
 * Usage:
 *   pnpm tsx examples/structured/typescript_example.ts
 */

import { createEngine } from '../../src/index.js';
import type { Engine } from '../../src/types/engine.js';

// Define TypeScript interfaces for type safety
interface UserProfile {
  name: string;
  age: number;
  email: string;
  role: 'admin' | 'user' | 'guest';
  active?: boolean;
}

interface ProductInfo {
  id: string;
  name: string;
  description: string;
  price: number;
  category: string;
  in_stock: boolean;
  tags: string[];
}

interface TaskItem {
  task_id: string;
  title: string;
  description?: string;
  priority: 'low' | 'medium' | 'high' | 'urgent';
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  assignee?: {
    name: string;
    email: string;
  };
  due_date?: string;
}

// JSON Schemas matching TypeScript interfaces
const USER_PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', minimum: 0 },
    email: { type: 'string', format: 'email' },
    role: { type: 'string', enum: ['admin', 'user', 'guest'] },
    active: { type: 'boolean' },
  },
  required: ['name', 'age', 'email', 'role'],
} as const;

const PRODUCT_INFO_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    category: { type: 'string' },
    in_stock: { type: 'boolean' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 5,
    },
  },
  required: ['id', 'name', 'description', 'price', 'category', 'in_stock', 'tags'],
} as const;

const TASK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    task_id: { type: 'string' },
    title: { type: 'string' },
    description: { type: 'string' },
    priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
    status: {
      type: 'string',
      enum: ['pending', 'in_progress', 'completed', 'cancelled'],
    },
    assignee: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        email: { type: 'string', format: 'email' },
      },
      required: ['name', 'email'],
    },
    due_date: { type: 'string', format: 'date' },
  },
  required: ['task_id', 'title', 'priority', 'status'],
} as const;

/**
 * Generate structured output with type safety
 */
async function generateStructured<T>(
  engine: Engine,
  modelId: string,
  prompt: string,
  schema: object,
  exampleTitle: string
): Promise<T> {
  console.log('\n' + '='.repeat(70));
  console.log(exampleTitle);
  console.log('='.repeat(70));
  console.log(`\nPrompt: ${prompt}`);
  console.log('\n' + '='.repeat(70));
  console.log('Generating...\n');

  // Create generator with guidance
  const generator = engine.createGenerator({
    model: modelId,
    prompt,
    maxTokens: 400,
    temperature: 0.3,
    guidance: {
      mode: 'json_schema',
      schema,
    },
  });

  // Collect output
  let output = '';
  let tokenCount = 0;

  for await (const chunk of generator) {
    if (chunk.type === 'token') {
      output += chunk.token;
      tokenCount++;
      process.stdout.write('.');
    } else if (chunk.type === 'stats') {
      console.log('\n\nGeneration Stats:');
      console.log(`  Tokens: ${chunk.tokensGenerated}`);
      console.log(`  Speed: ${chunk.tokensPerSecond.toFixed(2)} tokens/sec`);
      console.log(`  TTFT: ${(chunk.timeToFirstToken * 1000).toFixed(2)}ms`);
    }
  }

  console.log('\n');

  // Parse and validate
  try {
    const parsed = JSON.parse(output) as T;
    console.log('='.repeat(70));
    console.log('Generated JSON (Type-safe):');
    console.log('='.repeat(70));
    console.log(JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (error) {
    console.error('Failed to parse JSON:', error);
    console.error('Raw output:', output);
    throw error;
  }
}

/**
 * Example 1: Generate user profile
 */
async function exampleUserProfile(engine: Engine, modelId: string) {
  const user = await generateStructured<UserProfile>(
    engine,
    modelId,
    'Generate a user profile for Sarah Chen, a 32-year-old admin user with email sarah.chen@company.com',
    USER_PROFILE_SCHEMA,
    'Example 1: User Profile Generation'
  );

  // Type-safe access to properties
  console.log('\n' + '='.repeat(70));
  console.log('Type-safe Property Access:');
  console.log('='.repeat(70));
  console.log(`Name: ${user.name}`); // TypeScript knows this is a string
  console.log(`Age: ${user.age}`); // TypeScript knows this is a number
  console.log(`Role: ${user.role}`); // TypeScript knows this is 'admin' | 'user' | 'guest'
  console.log(`Email: ${user.email}`);
  console.log(`Active: ${user.active ?? 'not specified'}`);

  return user;
}

/**
 * Example 2: Generate product information
 */
async function exampleProductInfo(engine: Engine, modelId: string) {
  const product = await generateStructured<ProductInfo>(
    engine,
    modelId,
    'Create a product: iPhone 15 Pro, latest flagship smartphone with A17 Pro chip and titanium design, price $999, electronics category, in stock, tags: smartphone, apple, 5g, premium',
    PRODUCT_INFO_SCHEMA,
    'Example 2: Product Information'
  );

  // Type-safe access
  console.log('\n' + '='.repeat(70));
  console.log('Type-safe Property Access:');
  console.log('='.repeat(70));
  console.log(`Product: ${product.name} (${product.id})`);
  console.log(`Price: $${product.price.toFixed(2)}`);
  console.log(`Category: ${product.category}`);
  console.log(`Stock: ${product.in_stock ? 'Available' : 'Out of Stock'}`);
  console.log(`Tags: ${product.tags.join(', ')}`);

  return product;
}

/**
 * Example 3: Generate task item
 */
async function exampleTaskItem(engine: Engine, modelId: string) {
  const task = await generateStructured<TaskItem>(
    engine,
    modelId,
    'Create a task: Fix authentication bug (TASK-123), high priority, in progress, assigned to Bob Wilson (bob@dev.com), due 2025-02-01',
    TASK_ITEM_SCHEMA,
    'Example 3: Task Item'
  );

  // Type-safe access
  console.log('\n' + '='.repeat(70));
  console.log('Type-safe Property Access:');
  console.log('='.repeat(70));
  console.log(`Task: ${task.title} (${task.task_id})`);
  console.log(`Priority: ${task.priority.toUpperCase()}`);
  console.log(`Status: ${task.status}`);
  if (task.assignee) {
    console.log(`Assignee: ${task.assignee.name} <${task.assignee.email}>`);
  }
  if (task.due_date) {
    console.log(`Due: ${task.due_date}`);
  }

  return task;
}

/**
 * Example 4: Error handling
 */
async function exampleErrorHandling(engine: Engine, modelId: string) {
  console.log('\n' + '='.repeat(70));
  console.log('Example 4: Error Handling');
  console.log('='.repeat(70));

  try {
    // Intentionally use a problematic prompt
    await generateStructured<UserProfile>(
      engine,
      modelId,
      'Generate random text', // Vague prompt
      USER_PROFILE_SCHEMA,
      'Demonstrating Error Handling'
    );
  } catch (error: any) {
    console.log('\nExpected error caught:');
    console.log(`  Type: ${error.code || 'Unknown'}`);
    console.log(`  Message: ${error.message}`);
    console.log('  This demonstrates proper error handling for invalid outputs');
  }
}

/**
 * Main example runner
 */
async function main() {
  console.log('='.repeat(70));
  console.log('TypeScript Structured Output Example');
  console.log('='.repeat(70));

  // Create engine
  const engine = await createEngine();

  // Model path - adjust for your setup
  const modelPath = './models/llama-3.2-3b-instruct';
  // Or use HuggingFace:
  // const modelPath = 'meta-llama/Llama-3.2-3B-Instruct';

  console.log(`\nLoading model: ${modelPath}`);

  try {
    // Load model
    const modelHandle = await engine.loadModel({
      model: modelPath,
    });

    console.log(`Model loaded: ${modelHandle.modelId}`);

    // Run examples
    await exampleUserProfile(engine, modelHandle.modelId);
    await exampleProductInfo(engine, modelHandle.modelId);
    await exampleTaskItem(engine, modelHandle.modelId);
    // await exampleErrorHandling(engine, modelHandle.modelId); // Uncomment to test error handling

    console.log('\n' + '='.repeat(70));
    console.log('All examples completed successfully!');
    console.log('='.repeat(70));

    // Show type safety benefits
    console.log('\n' + '='.repeat(70));
    console.log('TypeScript Benefits:');
    console.log('='.repeat(70));
    console.log('✓ Full IntelliSense/autocomplete for generated objects');
    console.log('✓ Compile-time type checking');
    console.log('✓ Runtime validation via JSON schema');
    console.log('✓ Type-safe property access');
    console.log('✓ Enum constraints enforced');
  } catch (error) {
    console.error('\nError:', error);
    throw error;
  } finally {
    // Cleanup
    console.log('\nCleaning up...');
    await engine.dispose();
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

// Export functions for use in other modules
export { generateStructured, exampleUserProfile, exampleProductInfo, exampleTaskItem };
