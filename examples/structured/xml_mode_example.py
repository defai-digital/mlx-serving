#!/usr/bin/env python3
"""
XML Mode Example - Generate XML-formatted output

This example demonstrates how to use XML mode to generate
structured data in XML format with schema validation.

Requirements:
- kr-mlx-lm Python environment
- outlines >= 0.0.40
- A loaded text model (non-vision)

Usage:
    .kr-mlx-venv/bin/python examples/structured/xml_mode_example.py
"""

import asyncio
import sys
import os
import xml.etree.ElementTree as ET

# Add parent directory to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../python'))

from runtime import Runtime


# Define XML schemas
SIMPLE_PERSON_SCHEMA = """
<person>
    <name>string</name>
    <age>integer</age>
    <email>string</email>
    <occupation>string</occupation>
</person>
"""

PRODUCT_CATALOG_SCHEMA = """
<product>
    <id>string</id>
    <name>string</name>
    <description>string</description>
    <price>number</price>
    <category>string</category>
    <in_stock>boolean</in_stock>
</product>
"""

ORDER_SCHEMA = """
<order>
    <order_id>string</order_id>
    <customer>
        <name>string</name>
        <email>string</email>
        <phone>string</phone>
    </customer>
    <items>
        <item>
            <product_name>string</product_name>
            <quantity>integer</quantity>
            <price>number</price>
        </item>
    </items>
    <total>number</total>
    <status>string</status>
</order>
"""


async def generate_xml(runtime: Runtime, prompt: str, schema: str, title: str):
    """
    Generate XML output matching the schema.

    Args:
        runtime: Runtime instance with loaded model
        prompt: Description of what to generate
        schema: XML schema string
        title: Title for the example

    Returns:
        str: Generated XML string
    """
    print(f"\n{'='*70}")
    print(f"{title}")
    print(f"{'='*70}")
    print(f"\nPrompt: {prompt}")
    print(f"\nSchema:\n{schema}")
    print(f"\n{'='*70}")
    print("Generating XML...\n")

    # Prepare generation parameters
    params = {
        "prompt": prompt,
        "stream_id": f"{title.lower().replace(' ', '_')}_stream",
        "max_tokens": 300,
        "temperature": 0.1,  # Very low temperature for XML (recommended)
        "guidance": {
            "mode": "xml",
            "schema": schema
        }
    }

    # Generate with XML schema
    output = ""
    async for chunk in runtime._generate_stream(params):
        if chunk.get("type") == "chunk":
            token = chunk.get("token", "")
            output += token
            print(token, end="", flush=True)

    print("\n")

    # Validate XML
    try:
        root = ET.fromstring(output)
        print(f"{'='*70}")
        print("XML Validation: SUCCESS")
        print(f"{'='*70}")

        # Pretty print the XML
        ET.indent(root, space="  ")
        pretty_xml = ET.tostring(root, encoding='unicode')
        print("\nFormatted XML:")
        print(pretty_xml)

        return output
    except ET.ParseError as e:
        print(f"{'='*70}")
        print(f"XML Validation: FAILED")
        print(f"Error: {e}")
        print(f"{'='*70}")
        print(f"Raw output:\n{output}")
        return None


async def main():
    """Main example function"""
    print("=" * 70)
    print("XML Mode Example - Structured XML Generation")
    print("=" * 70)

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

        # Example 1: Simple person XML
        await generate_xml(
            runtime,
            "Generate XML for a person: Alice Smith, 28 years old, software engineer, email alice@tech.com",
            SIMPLE_PERSON_SCHEMA,
            "Example 1: Person Profile"
        )

        # Example 2: Product catalog entry
        await generate_xml(
            runtime,
            "Create a product XML: MacBook Pro, high-performance laptop for professionals, $2399.99, electronics category, in stock",
            PRODUCT_CATALOG_SCHEMA,
            "Example 2: Product Catalog Entry"
        )

        # Example 3: Order with nested items
        await generate_xml(
            runtime,
            "Generate an order XML: Order #12345, customer Bob Johnson (bob@example.com, 555-0123), ordered 2 laptops at $1200 each and 1 mouse at $25, total $2425, status pending",
            ORDER_SCHEMA,
            "Example 3: Order with Items"
        )

        print("\n" + "=" * 70)
        print("All examples completed successfully!")
        print("=" * 70)

        # Demonstrate XML parsing
        print("\n" + "=" * 70)
        print("Bonus: Parsing Generated XML")
        print("=" * 70)

        # Generate one more for parsing demo
        print("\nGenerating person XML for parsing demo...")
        params = {
            "prompt": "Generate XML for: Charlie Brown, age 35, teacher, charlie@school.edu",
            "stream_id": "parse_demo_stream",
            "max_tokens": 200,
            "temperature": 0.1,
            "guidance": {
                "mode": "xml",
                "schema": SIMPLE_PERSON_SCHEMA
            }
        }

        output = ""
        async for chunk in runtime._generate_stream(params):
            if chunk.get("type") == "chunk":
                output += chunk.get("token", "")

        # Parse and extract data
        try:
            root = ET.fromstring(output)
            print("\nExtracted Data:")
            print(f"  Name: {root.find('name').text}")
            print(f"  Age: {root.find('age').text}")
            print(f"  Email: {root.find('email').text}")
            print(f"  Occupation: {root.find('occupation').text}")
        except Exception as e:
            print(f"Error parsing XML: {e}")

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
