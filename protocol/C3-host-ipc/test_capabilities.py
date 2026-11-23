import json
import re
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CONTRACT = (HERE / 'CONTRACT.md').read_text(encoding='utf-8')
TABLE = json.loads((HERE / 'capabilities.json').read_text(encoding='utf-8'))
PRIVATE = ROOT / 'private'
EFW = PRIVATE / 'renderer' / 'windows' / 'src'
MAC_LINK = PRIVATE / 'renderer' / 'host' / 'Sources' / 'NativeHostBridge' / 'Link.m'
NO_PRIVATE = 'the renderer sources are not in this checkout; they are not compared'


def strings(text, quote='"'):
    return re.findall(quote + r'([a-z_]+)"', text)


def contract_renderer_capabilities():
    """The 「能力」 table's rows a renderer lists, and `presentation`, which has its own section."""
    section = CONTRACT.split('\n## 能力（v9）\n', 1)[1].split('\n## ', 1)[0]
    rows = re.findall(r'^\| `([a-z_]+)` \| (渲染器|Companion|两边) \|', section, re.M)
    names = {name for name, side in rows if side != 'Companion'}
    if '\n### Optional presentation capability\n' in CONTRACT:
        names.add('presentation')
    return names


def efw_hello():
    """Static read of the names efw's hello can list: the base list, capture and HostSpeech::capabilities."""
    host = (EFW / 'host.cpp').read_text(encoding='utf-8')
    names = strings(re.search(r'std::vector<Json> capabilities = \{(.*?)\};', host, re.S).group(1))
    names += re.findall(r'capabilities\.push_back\("([a-z_]+)"\)', host)
    speech = (EFW / 'host_speech.cpp').read_text(encoding='utf-8')
    names += strings(re.search(r'HostSpeech::capabilities\(\) const \{.*?return \{("[^}]*)\};', speech, re.S).group(1))
    return set(names)


def mac_hello():
    """Static read of the names the Metal host's hello can list: the base list, arrayByAddingObject and kOptionalCapabilities."""
    link = MAC_LINK.read_text(encoding='utf-8')
    names = strings(re.search(r'@"capabilities": @\[(.*?)\]', link, re.S).group(1), '@"')
    names += re.findall(r'arrayByAddingObject:@"([a-z_]+)"', link)
    names += strings(re.search(r'kOptionalCapabilities\[\] = \{(.*?)\};', link, re.S).group(1))
    return set(names)


def listed(platform):
    return {name for name, row in TABLE['capabilities'].items() if row[platform] == 'yes'}


def mismatch(table, source):
    return {'only in capabilities.json': sorted(table - source), 'only in the source': sorted(source - table)}


class CapabilityTableTests(unittest.TestCase):
    def test_rows_are_well_formed(self):
        for name, row in TABLE['capabilities'].items():
            self.assertTrue({row['mac'], row['windows']} <= {'yes', 'no', 'by_design'}, name)
            self.assertEqual('ref' in row, row['mac'] != 'yes' or row['windows'] != 'yes', name)
        for name, row in TABLE['render_settings'].items():
            self.assertTrue({row['mac'], row['windows']} <= {'applied', 'fixed', 'ignored'}, name)
            self.assertEqual('ref' in row, row['mac'] != 'applied' or row['windows'] != 'applied', name)

    def test_refs_point_at_contract_lines(self):
        lines = CONTRACT.count('\n') + (not CONTRACT.endswith('\n'))
        for name, row in [*TABLE['capabilities'].items(), *TABLE['render_settings'].items()]:
            if 'ref' in row:
                m = re.fullmatch(r'CONTRACT\.md:(\d+)', row['ref'])
                self.assertTrue(m and 1 <= int(m.group(1)) <= lines, f'{name}: {row["ref"]}')

    def test_every_capability_is_in_the_contract(self):
        for name in TABLE['capabilities']:
            self.assertIn(f'`{name}`', CONTRACT, name)

    def test_every_renderer_capability_of_the_contract_is_in_the_table(self):
        self.assertEqual(sorted(contract_renderer_capabilities() - set(TABLE['capabilities'])), [])

    def test_a_capability_the_source_adds_is_caught(self):
        self.assertEqual(mismatch(listed('windows'), listed('windows') | {'moving'})['only in the source'], ['moving'])


@unittest.skipUnless(PRIVATE.is_dir(), NO_PRIVATE)
class RendererSourceTests(unittest.TestCase):
    """Static comparison by literal capability name: what each hello can list, not what one run lists."""

    def test_efw_hello_matches_windows_yes(self):
        self.assertEqual(mismatch(listed('windows'), efw_hello()), mismatch(set(), set()))

    def test_mac_hello_matches_mac_yes(self):
        self.assertEqual(mismatch(listed('mac'), mac_hello()), mismatch(set(), set()))

    def test_efw_reports_unsupported_settings_by_the_table(self):
        # host-common's generated table (protocol/tools/gen_render_table.py) is the only list of what efw draws fixed.
        host = (EFW / 'host.cpp').read_text(encoding='utf-8')
        self.assertNotIn('kFixed', host)
        self.assertIn('hc_render_settings_unsupported(HC_RENDER_WINDOWS', host)


if __name__ == '__main__':
    unittest.main()
