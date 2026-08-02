from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

from rollout import parse_agent_action


REPO = Path(__file__).resolve().parents[2]
FIXTURES = [
    '{"tool":"api_search","arguments":{"query":"crm"}}',
    '```json\n{"tool":"api_fetch","arguments":{"method":"GET","url":"/crm/contacts"}}\n```',
    'The action is {"tool":"finish","arguments":{}}. Done.',
    '{"tool":"api_fetch","arguments":"{\\"method\\":\\"GET\\",\\"url\\":\\"/crm/contacts\\"}"}',
    '{"name":"api_search","arguments":{"query":"mail"}}',
    '{"finish":true}',
    '{"arguments":{}}',
    'garbage',
    "",
    '{"tool":"api_search","arguments":[]}',
]


class ParserCompatibilityTest(unittest.TestCase):
    def test_python_matches_typescript_parser(self) -> None:
        expression = (
            "import { parseAgentAction } from './dist/automationbench-rl-service.js';"
            f"console.log(JSON.stringify({json.dumps(FIXTURES)}.map(parseAgentAction)));"
        )
        expected = json.loads(
            subprocess.check_output(
                ["node", "--input-type=module", "-e", expression],
                cwd=REPO,
                text=True,
            )
        )
        self.assertEqual([parse_agent_action(fixture) for fixture in FIXTURES], expected)


if __name__ == "__main__":
    unittest.main()
