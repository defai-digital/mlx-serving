# Structured Output Examples

This directory contains examples of using kr-mlx-lm with Outlines for structured output generation.

## Overview

Structured output generation constrains the language model to produce text that follows a specific format (JSON schema or XML). This ensures type-safe, validated outputs that integrate seamlessly with your application.

## Examples

### 1. JSON Schema Example (`json_schema_example.py`)

**Purpose**: Demonstrates basic JSON schema usage for generating user profiles.

**Features**:
- Simple object schema with primitive types
- Email format validation
- Enum constraints for roles
- Required vs optional fields

**Run**:
```bash
.kr-mlx-venv/bin/python examples/structured/json_schema_example.py
```

**Key Concepts**:
- Defining JSON schema
- Basic type constraints
- Format validation (email)
- Enum values

### 2. XML Mode Example (`xml_mode_example.py`)

**Purpose**: Shows how to generate XML-formatted output with schema validation.

**Features**:
- Simple and complex XML schemas
- Nested XML structures
- XML parsing and validation
- Multiple XML use cases

**Run**:
```bash
.kr-mlx-venv/bin/python examples/structured/xml_mode_example.py
```

**Key Concepts**:
- XML schema definition
- Nested XML elements
- XML validation
- Best practices for XML generation

### 3. Complex Schema Example (`complex_schema_example.py`)

**Purpose**: Demonstrates advanced schema features with real-world use cases.

**Features**:
- E-commerce order system (deeply nested)
- Task management system (arrays of objects)
- Restaurant menu (categories and items)
- Pattern validation (order IDs, zip codes)

**Run**:
```bash
.kr-mlx-venv/bin/python examples/structured/complex_schema_example.py
```

**Key Concepts**:
- Nested objects (3-4 levels deep)
- Arrays with constraints (minItems, maxItems)
- Pattern validation (regex)
- Complex enum constraints
- Optional fields
- Multiple data types

**Schemas**:
- **E-commerce Order**: Customer info + nested address + items array + payment + shipping
- **Task Management**: Project + tasks array with assignees
- **Restaurant Menu**: Restaurant + categories + menu items with dietary info

### 4. TypeScript Example (`typescript_example.ts`)

**Purpose**: Type-safe structured output generation from TypeScript.

**Features**:
- TypeScript interface definitions
- JSON schema matching TypeScript types
- Full IntelliSense support
- Type-safe property access
- Error handling

**Run**:
```bash
pnpm tsx examples/structured/typescript_example.ts
```

**Key Concepts**:
- TypeScript + JSON schema integration
- Type inference from schema
- Compile-time type checking
- Runtime validation
- Using Zod for schema generation (commented example)

## Quick Start

### 1. Setup

Ensure your Python environment is configured:

```bash
# Install dependencies
pnpm install

# Setup Python environment
pnpm prepare:python

# Verify Outlines is installed
.kr-mlx-venv/bin/python -c "import outlines; print(outlines.__version__)"
```

### 2. Download a Model

Use a local model for faster testing:

```bash
# Download from HuggingFace (example)
huggingface-cli download meta-llama/Llama-3.2-3B-Instruct --local-dir ./models/llama-3.2-3b-instruct
```

Or use HuggingFace model IDs directly (requires internet):

```python
model_path = "meta-llama/Llama-3.2-3B-Instruct"
```

### 3. Run an Example

```bash
# Python example
.kr-mlx-venv/bin/python examples/structured/json_schema_example.py

# TypeScript example
pnpm tsx examples/structured/typescript_example.ts
```

## Creating Your Own Schema

### JSON Schema Template

```python
MY_SCHEMA = {
    "type": "object",
    "properties": {
        "field1": {
            "type": "string",
            "description": "Description of field"
        },
        "field2": {
            "type": "integer",
            "minimum": 0,
            "maximum": 100
        },
        "field3": {
            "type": "string",
            "enum": ["option1", "option2", "option3"]
        }
    },
    "required": ["field1", "field2"]
}
```

### Usage Pattern

```python
from runtime import Runtime

runtime = Runtime()
await runtime.load_model({"model": "path/to/model"})

params = {
    "prompt": "Your prompt here",
    "stream_id": "unique_id",
    "max_tokens": 300,
    "temperature": 0.3,
    "guidance": {
        "mode": "json_schema",
        "schema": MY_SCHEMA
    }
}

output = ""
async for chunk in runtime._generate_stream(params):
    if chunk.get("type") == "chunk":
        output += chunk.get("token", "")

data = json.loads(output)  # Guaranteed to match schema
```

## Best Practices

### 1. Schema Design

- **Keep it simple**: Start with simple schemas, add complexity gradually
- **Use constraints**: Add `minimum`, `maximum`, `enum` for better guidance
- **Limit nesting**: Avoid more than 3-4 levels of nesting
- **Size matters**: Keep schemas under 10KB

### 2. Temperature Settings

- **JSON Schema**: Use 0.2-0.5 for balance of creativity and structure
- **XML Mode**: Use 0.0-0.2 for strict formatting

### 3. Prompts

- **Be specific**: "Generate a user with name, age, email"
- **Provide context**: "Create a product JSON for electronics"
- **Match schema**: Ensure prompt aligns with schema fields

### 4. Error Handling

Always wrap generation in try-catch:

```typescript
try {
  const output = await generateStructured(schema);
} catch (error) {
  if (error.code === 'GUIDANCE_ERROR') {
    // Schema validation failed
  } else if (error.code === 'GENERATION_ERROR') {
    // Generation failed
  }
}
```

## Common Issues

### Issue: "Outlines not available"

**Solution**: Reinstall Python environment
```bash
pnpm prepare:python
```

### Issue: "Model incompatible with guidance"

**Solution**: Use text-only models (not vision models)
- ✓ Llama, Mistral, Phi, Qwen
- ✗ LLaVA, Qwen-VL

### Issue: "Schema too large"

**Solution**: Simplify schema or increase limit in `config/runtime.yaml`
```yaml
guidance:
  max_schema_size_bytes: 131072  # 128KB
```

### Issue: Generation hangs

**Solutions**:
- Lower temperature (0.1-0.3)
- Simplify schema
- Add `max_tokens` limit
- Use clearer prompt

## Performance Tips

1. **Reuse schemas**: Don't recreate schemas for each generation
2. **Batch requests**: Generate multiple outputs with same schema
3. **Optimize size**: Remove unnecessary constraints
4. **Monitor memory**: Large schemas consume more RAM

## Supported JSON Schema Features

- ✓ Primitive types: string, number, integer, boolean, null
- ✓ Complex types: object, array
- ✓ Constraints: required, enum, minimum, maximum, minLength, maxLength
- ✓ Formats: email, uri, date-time, date
- ✓ Nested structures: Objects in objects, arrays of objects
- ✓ Pattern validation: Regular expressions
- ✓ Array constraints: minItems, maxItems

## Documentation

For complete documentation, see:
- [Outlines Integration Guide](../../docs/OUTLINES_GUIDE.md) - Comprehensive guide
- [CLAUDE.md](../../CLAUDE.md) - Architecture and development guide
- [Outlines Documentation](https://outlines-dev.github.io/outlines/) - Outlines library docs

## Support

- GitHub Issues: https://github.com/defai-digital/kr-mlx-lm/issues
- Discussions: https://github.com/defai-digital/kr-mlx-lm/discussions
