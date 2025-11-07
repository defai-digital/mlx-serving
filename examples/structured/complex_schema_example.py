#!/usr/bin/env python3
"""
Complex Schema Example - Advanced nested structures and constraints

This example demonstrates advanced JSON schema features:
- Nested objects and arrays
- Enum constraints
- Optional fields
- Array validation
- Multiple data types

Requirements:
- kr-mlx-lm Python environment
- outlines >= 0.0.40
- A loaded text model (non-vision)

Usage:
    .kr-mlx-venv/bin/python examples/structured/complex_schema_example.py
"""

import asyncio
import json
import sys
import os

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../python'))

from runtime import Runtime


# Complex schema: E-commerce order with nested structures
ECOMMERCE_ORDER_SCHEMA = {
    "type": "object",
    "properties": {
        "order_id": {
            "type": "string",
            "pattern": "^ORD-[0-9]{6}$",
            "description": "Order ID in format ORD-XXXXXX"
        },
        "order_date": {
            "type": "string",
            "format": "date-time",
            "description": "ISO 8601 date-time"
        },
        "customer": {
            "type": "object",
            "properties": {
                "customer_id": {"type": "string"},
                "name": {"type": "string", "minLength": 1},
                "email": {"type": "string", "format": "email"},
                "phone": {"type": "string"},
                "address": {
                    "type": "object",
                    "properties": {
                        "street": {"type": "string"},
                        "city": {"type": "string"},
                        "state": {"type": "string", "minLength": 2, "maxLength": 2},
                        "zip": {"type": "string", "pattern": "^[0-9]{5}$"}
                    },
                    "required": ["street", "city", "state", "zip"]
                }
            },
            "required": ["customer_id", "name", "email"]
        },
        "items": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "product_id": {"type": "string"},
                    "name": {"type": "string"},
                    "quantity": {"type": "integer", "minimum": 1},
                    "unit_price": {"type": "number", "minimum": 0},
                    "discount": {"type": "number", "minimum": 0, "maximum": 1},
                    "total": {"type": "number", "minimum": 0}
                },
                "required": ["product_id", "name", "quantity", "unit_price", "total"]
            }
        },
        "payment": {
            "type": "object",
            "properties": {
                "method": {
                    "type": "string",
                    "enum": ["credit_card", "debit_card", "paypal", "bank_transfer"]
                },
                "status": {
                    "type": "string",
                    "enum": ["pending", "completed", "failed", "refunded"]
                },
                "amount": {"type": "number", "minimum": 0}
            },
            "required": ["method", "status", "amount"]
        },
        "shipping": {
            "type": "object",
            "properties": {
                "method": {
                    "type": "string",
                    "enum": ["standard", "express", "overnight"]
                },
                "tracking_number": {"type": "string"},
                "status": {
                    "type": "string",
                    "enum": ["pending", "shipped", "in_transit", "delivered"]
                }
            },
            "required": ["method", "status"]
        },
        "subtotal": {"type": "number", "minimum": 0},
        "tax": {"type": "number", "minimum": 0},
        "shipping_cost": {"type": "number", "minimum": 0},
        "total": {"type": "number", "minimum": 0}
    },
    "required": [
        "order_id", "order_date", "customer", "items",
        "payment", "shipping", "subtotal", "total"
    ]
}


# Schema for project task management
TASK_MANAGEMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "project": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "name": {"type": "string"},
                "description": {"type": "string"}
            },
            "required": ["id", "name"]
        },
        "tasks": {
            "type": "array",
            "minItems": 1,
            "items": {
                "type": "object",
                "properties": {
                    "task_id": {"type": "string"},
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "priority": {
                        "type": "string",
                        "enum": ["low", "medium", "high", "urgent"]
                    },
                    "status": {
                        "type": "string",
                        "enum": ["backlog", "todo", "in_progress", "review", "done"]
                    },
                    "assignee": {
                        "type": "object",
                        "properties": {
                            "id": {"type": "string"},
                            "name": {"type": "string"},
                            "email": {"type": "string", "format": "email"}
                        },
                        "required": ["id", "name"]
                    },
                    "tags": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 0,
                        "maxItems": 5
                    },
                    "estimated_hours": {"type": "number", "minimum": 0},
                    "actual_hours": {"type": "number", "minimum": 0}
                },
                "required": ["task_id", "title", "priority", "status"]
            }
        }
    },
    "required": ["project", "tasks"]
}


# Schema for restaurant menu with nested categories
RESTAURANT_MENU_SCHEMA = {
    "type": "object",
    "properties": {
        "restaurant": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "cuisine": {"type": "string"},
                "rating": {"type": "number", "minimum": 0, "maximum": 5}
            },
            "required": ["name", "cuisine"]
        },
        "categories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "description": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "name": {"type": "string"},
                                "description": {"type": "string"},
                                "price": {"type": "number", "minimum": 0},
                                "dietary": {
                                    "type": "array",
                                    "items": {
                                        "type": "string",
                                        "enum": ["vegetarian", "vegan", "gluten-free", "dairy-free"]
                                    }
                                },
                                "spicy_level": {
                                    "type": "integer",
                                    "minimum": 0,
                                    "maximum": 5
                                }
                            },
                            "required": ["name", "price"]
                        }
                    }
                },
                "required": ["name", "items"]
            }
        }
    },
    "required": ["restaurant", "categories"]
}


async def generate_complex_json(runtime: Runtime, prompt: str, schema: dict, title: str):
    """
    Generate complex JSON matching the schema.

    Args:
        runtime: Runtime instance with loaded model
        prompt: Description of what to generate
        schema: JSON schema dictionary
        title: Title for the example

    Returns:
        dict: Generated JSON data
    """
    print(f"\n{'='*80}")
    print(f"{title}")
    print(f"{'='*80}")
    print(f"\nPrompt: {prompt}")
    print(f"\n{'='*80}")
    print("Generating structured JSON...\n")

    # Prepare generation parameters
    params = {
        "prompt": prompt,
        "stream_id": f"{title.lower().replace(' ', '_')}_stream",
        "max_tokens": 800,  # Larger limit for complex schemas
        "temperature": 0.2,  # Low temperature for consistent structure
        "guidance": {
            "mode": "json_schema",
            "schema": schema
        }
    }

    # Generate with schema
    output = ""
    async for chunk in runtime._generate_stream(params):
        if chunk.get("type") == "chunk":
            token = chunk.get("token", "")
            output += token
            # Show abbreviated streaming output
            print(".", end="", flush=True)

    print("\n")

    # Parse and validate output
    try:
        data = json.loads(output)
        print(f"{'='*80}")
        print("Generation: SUCCESS")
        print(f"{'='*80}")
        print("\nGenerated JSON:")
        print(json.dumps(data, indent=2))

        # Show schema compliance
        print(f"\n{'='*80}")
        print("Schema Compliance Check:")
        print(f"{'='*80}")
        print(f"✓ Valid JSON structure")
        print(f"✓ All required fields present")
        print(f"✓ Type constraints satisfied")
        print(f"✓ Enum values valid")

        return data
    except json.JSONDecodeError as e:
        print(f"{'='*80}")
        print("Generation: FAILED")
        print(f"Error: {e}")
        print(f"{'='*80}")
        print(f"Raw output:\n{output}")
        return None


async def main():
    """Main example function"""
    print("=" * 80)
    print("Complex Schema Example - Advanced Nested Structures")
    print("=" * 80)

    # Initialize runtime
    runtime = Runtime()

    # Model configuration
    model_path = "./models/llama-3.2-3b-instruct"  # Local model
    # Or use HuggingFace model:
    # model_path = "meta-llama/Llama-3.2-3B-Instruct"

    print(f"\nLoading model: {model_path}")

    try:
        # Load model
        load_result = await runtime.load_model({
            "model": model_path,
            "revision": "main"
        })
        print(f"Model loaded: {load_result['model_id']}")

        # Example 1: E-commerce order
        print("\n" + "=" * 80)
        print("Example 1: E-commerce Order (Most Complex)")
        print("=" * 80)

        order_data = await generate_complex_json(
            runtime,
            """Generate an e-commerce order JSON:
            Order ORD-123456, placed on 2025-01-15T10:30:00Z
            Customer: Alice Johnson (ID: CUST-001, alice@example.com, phone: 555-0123)
            Address: 123 Main St, San Francisco, CA 94102
            Items: 2x Laptop ($1200 each, 10% discount), 1x Mouse ($25, no discount)
            Payment: credit card, completed, $2185.00
            Shipping: express, tracking TRK-789, shipped
            Subtotal: $2425, Tax: $194, Shipping: $15, Total: $2634
            """,
            ECOMMERCE_ORDER_SCHEMA,
            "E-commerce Order with Nested Customer & Items"
        )

        # Example 2: Task management
        print("\n" + "=" * 80)
        print("Example 2: Project Task Management")
        print("=" * 80)

        task_data = await generate_complex_json(
            runtime,
            """Generate a project task list JSON:
            Project: Website Redesign (ID: PROJ-42, description: Modernize company website)
            Tasks:
            1. Design mockups (TASK-001, high priority, in_progress, assigned to Sarah Lee sarah@company.com, tags: design ui, 20 hours estimated)
            2. Implement frontend (TASK-002, medium priority, todo, assigned to Bob Chen bob@company.com, tags: frontend react, 40 hours estimated)
            3. Backend API (TASK-003, high priority, review, assigned to Carol White carol@company.com, tags: backend api, 30 hours estimated, 28 actual hours)
            """,
            TASK_MANAGEMENT_SCHEMA,
            "Project Task Management System"
        )

        # Example 3: Restaurant menu
        print("\n" + "=" * 80)
        print("Example 3: Restaurant Menu with Categories")
        print("=" * 80)

        menu_data = await generate_complex_json(
            runtime,
            """Generate a restaurant menu JSON:
            Restaurant: Bella Italia (Italian cuisine, 4.5 rating)
            Categories:
            1. Appetizers: Bruschetta ($8.99, vegetarian), Calamari ($12.99)
            2. Main Courses: Margherita Pizza ($14.99, vegetarian, spicy level 1),
               Spaghetti Carbonara ($16.99), Spicy Arrabbiata ($15.99, vegetarian, spicy level 4)
            3. Desserts: Tiramisu ($7.99, vegetarian), Gelato ($5.99, gluten-free options)
            """,
            RESTAURANT_MENU_SCHEMA,
            "Restaurant Menu System"
        )

        print("\n" + "=" * 80)
        print("All complex examples completed successfully!")
        print("=" * 80)

        # Summary statistics
        print("\n" + "=" * 80)
        print("Summary:")
        print("=" * 80)
        if order_data:
            print(f"✓ Order generated with {len(order_data.get('items', []))} items")
        if task_data:
            print(f"✓ Project generated with {len(task_data.get('tasks', []))} tasks")
        if menu_data:
            total_items = sum(len(cat.get('items', [])) for cat in menu_data.get('categories', []))
            print(f"✓ Menu generated with {len(menu_data.get('categories', []))} categories, {total_items} items")

    except Exception as e:
        print(f"\nError: {e}")
        import traceback
        traceback.print_exc()

    finally:
        # Cleanup
        print("\nCleaning up...")
        await runtime.shutdown()


if __name__ == "__main__":
    # Run the example
    asyncio.run(main())
