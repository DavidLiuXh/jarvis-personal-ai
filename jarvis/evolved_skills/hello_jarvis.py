import sys
import json

# Evolved Skill: Hello Jarvis
# This script is called with a JSON string as the first argument
try:
    args = json.loads(sys.argv[1])
    name = args.get('name', 'Stranger')
    print(f"Hello {name}! I am an evolved skill running directly on your system.")
except Exception as e:
    print(f"Error: {str(e)}")
