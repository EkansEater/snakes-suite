"""Entry point: `python -m snakes_suite` or the `snakes-suite` command."""

import sys

from .app import main

if __name__ == "__main__":
    sys.exit(main())
