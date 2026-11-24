"""glTF node hierarchy checks."""
from pathlib import Path
import sys
import unittest

CHARACTERS=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(CHARACTERS)]
from agentic_complex_build.motion_import import gltf


class HierarchyTests(unittest.TestCase):
    def test_a_cycle_is_a_bad_hierarchy(self):
        """Neck and Spine are each other's child: every node has one parent, yet no root reaches them."""
        doc={'nodes':[{'name':'Hips'},{'name':'Neck','children':[2]},{'name':'Spine','children':[1]}]}
        with self.assertRaisesRegex(ValueError,'^bad_source: hierarchy$'):gltf.parents(doc)

    def test_a_forest_gives_each_node_its_parent(self):
        doc={'nodes':[{'name':'Hips','children':[2]},{'name':'Prop'},{'name':'Spine','children':[3]},{'name':'Neck'}]}
        self.assertEqual(gltf.parents(doc),[-1,-1,0,2])


if __name__=='__main__':
    unittest.main()
