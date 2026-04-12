# Self-healing Code Generation

An automated Python code generation and testing system that uses a local LLaMA server to write, execute, and iteratively improve code based on a given requirement.

## Overview

This tool automates the process of:
1. Starting a local LLaMA server
2. Sending a coding requirement to the LLM
3. Generating Python code based on the requirement
4. Executing the generated code
5. Validating the output against the requirement
6. Iteratively correcting the code if it fails (up to 64 attempts)

## Features

- **Automated Code Generation**: Uses a local LLM server to generate Python code from natural language requirements
- **Self-Correction**: Automatically detects errors and requests corrected code from the LLM
- **Execution & Validation**: Runs the generated code and validates the output
- **Configurable**: Easy to modify requirements, paths, and model parameters
- **Windows Optimized**: Includes proper process management for Windows systems

## How It Works

1. Starts a local `llama-server.exe` process
2. Creates a project directory structure
3. Sends the coding requirement to the LLM
4. Saves the generated code to `Main.py`
5. Executes the code and captures output
6. Sends execution results back to LLM for validation
7. If validation fails, requests corrected code and repeats (up to 64 times)
8. Cleans up server processes when done

## Installation

### Prerequisites

- Python 3.11+
- https://github.com/ggerganov/llama.cpp server executable
- A GGUF model file (e.g., `gemma-4-31B-it-Q6_K.gguf`)

### Setup

1. Clone this repository:
```bash
git clone https://github.com/qidiliu/Self-healing_Code_Gen.git
cd Self-healing_Code_Gen
```

2. Install required Python packages:
```bash
pip install requests
```

3. Configure the script:
    - Update `SERVER_CMD` with the path to your `llama-server.exe`
    - Update `PROJECT_ROOT` with your desired project directory
    - Modify `USER_REQUIREMENT` with your coding task

## Configuration

Edit the configuration section at the top of the script:

```python
# Path to your llama-server executable and model
SERVER_CMD = r"C:\path\to\llama-server.exe -m C:\path\to\model.gguf -c 16384"

# Project directory
PROJECT_ROOT = r"C:\path\to\project"

# Your coding requirement
USER_REQUIREMENT = "Write a Python program that calculates..."
```

## Usage

Run the script:

```bash
python Main.py
```

The script will:
1. Display progress messages
2. Show generated code in each iteration
3. Print execution output
4. Indicate success or failure
5. Provide failure analysis if all attempts are exhausted

## Key Functions

- `call_llama()`: Communicates with the LLaMA server
- `clean_code()`: Removes markdown formatting from LLM responses
- `run_python_code()`: Executes the generated Python code
- `main()`: Orchestrates the entire generation and testing process

## Limitations (also To-do lists for me)

- Requires a local LLM server setup
- Limited to Python code generation
- No harness engineering

## Example

For the default requirement ("Write a Python program that calculates the first 10 numbers of the Fibonacci sequence and prints them"), the tool will generate, execute, and validate code until it produces the correct output.

## License

MIT License
