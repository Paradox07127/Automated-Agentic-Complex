import copy
import json
import unittest

import neutral_package as module


def attachment(target, load="clear"):
    return dict(target=target, load=load, store="store", clear=[0, 0, 0, 0])


def state():
    return dict(fields=dict(zTest=8, zWrite=0), stencil=dict(stencilOp=dict(comp=8)),
                blend=dict(rtBlend0=dict(srcBlend=1, destBlend=0, colMask=15)))


def stages(vs, fs):
    return [dict(bindings=[], source_spirv="/build/%s.spv" % vs, source_spirv_sha256=vs, stage=0),
            dict(bindings=[], source_spirv="/build/%s.spv" % fs, source_spirv_sha256=fs, stage=1)]


def fullscreen(vs, fs, adapter=None):
    f = dict(stages=stages(vs, fs), resources=[dict(category="ubos", set=3, binding=5, names=["HGApplyCB"], file="Objects/c.bytes", sha256="c", byte_count=464)],
             native_state=state())
    if adapter:f["vertex_adapter"] = adapter
    return f


def render(name, phase, colors, reads, **extra):
    p = dict(id=name, phase=phase, kind=extra.pop("kind", "render"), colors=[attachment(c) for c in colors], reads=reads, draws=[], front_facing="clockwise")
    p.update(extra); return p


def graph(fused=True, additive=False):
    """A frame_build + frame_smaa_fixture shaped graph: one draw, a stencil-tested resolve, bloom, uber-post and the product tail."""
    out, post = ("aa-input", "aa-input") if fused else ("l1", "post-gamma")
    targets = [dict(id="pre0", width=8, height=8, format="rgba8Unorm"), dict(id="depth", width=8, height=8, format="depth32Float_stencil8"),
               dict(id="hdr", width=8, height=8, format="rgba32Float"), dict(id=out, width=4 if fused else 8, height=4 if fused else 8, format="rgba16Float")]
    if not fused:targets.append(dict(id="post-gamma", width=8, height=8, format="rgba32Float"))
    targets += [dict(id="screen-shadow", width=8, height=8, format="rg8Unorm"), dict(id="bloom-up-0", width=2, height=2, format="rg11b10Float")]
    passes = [
        render("pre-gbuffer", "pre-gbuffer", ["pre0"], ["snapshot-0"], draws=[0], texture_bindings={"draw:0:separate_images:0:1": "snapshot-0"},
               depth=attachment("depth"), stencil=attachment("depth"), sampler_overrides={"draw:0:1:aa:0:4": dict(min_filter="linear")}),
        render("screen-shadow-resolve", "screen-shadow-resolve", ["screen-shadow"], ["pre0"], texture_bindings={"separate_images:3:5": "pre0"},
               fullscreen=[fullscreen("ssv", "ssf")], depth=attachment("depth", "load"), stencil=attachment("depth", "load")),
        render("forward-0", "forward", ["hdr"], ["screen-shadow"], draws=[1], texture_bindings={}, depth=attachment("depth", "load"), stencil=attachment("depth", "load"),
               sampler_overrides={}),
        render("bloom-0", "bloom", ["bloom-up-0"], ["hdr"], texture_bindings={"separate_images:3:1": "hdr"}, fullscreen=[fullscreen("bv", "bf", module.HELPER_VS)]),
    ]
    uber = render("uber-post", "uber-post", [post], ["bloom-up-0", "hdr"], texture_bindings={"separate_images:3:3": "hdr"}, fullscreen=[fullscreen("uv", "uf", module.HELPER_VS)])
    passes.append(uber)
    samplers = {"1:bf:0:4": dict(min_filter="linear"), "1:uf:0:4": dict(min_filter="linear")}
    g = dict(schema=module.FRAME_SCHEMA, manifest_sha256="m" * 64, width=8, height=8, targets=targets,
             textures=[dict(id="snapshot-0", resource=dict(texture=dict(width=1, height=1), file="Objects/s.bytes", sha256="s", byte_count=4))],
             semantic_textures={"_ScreenSpaceShadowMask": "screen-shadow"}, sampler_overrides=samplers, passes=passes)
    if not fused:
        passes.append(render("linearize-post", "l1", ["l1"], ["post-gamma"], kind="linearize_post"))
    else:
        uber["fullscreen"][0]["fragment_adapter"] = module.FUSED_ADD if additive else module.FUSED
        if additive:
            targets.append(dict(id="post-add", width=4, height=4, format="rgba16Float"))
            uber["colors"].append(attachment("post-add", "dontCare"))
            uber["fullscreen"][0]["native_state"]["blend"]["rtBlend1"] = dict(uber["fullscreen"][0]["native_state"]["blend"]["rtBlend0"])
        targets[4:4] = [dict(id="aa-premultiplied", width=4, height=4, format="rgba16Float"), dict(id="aa-edges", width=4, height=4, format="rgba8Unorm")]
        targets.append(dict(id="l1", width=4, height=4, format="rgba16Float"))
        g["textures"].append(dict(id="aa-areatex", resource=dict(texture=dict(width=1, height=1), file="AAObjects/a.bytes", sha256="a", byte_count=2, names=["_AreaTex"])))
        passes += [render("smaa-premultiply", "smaa-premultiply", ["aa-premultiplied"], ["aa-input"], kind="premultiply_alpha"),
                   render("smaa-edges", "smaa-edges", ["aa-edges"], ["aa-premultiplied", "aa-areatex"], texture_bindings={"separate_images:3:2": "aa-premultiplied"},
                          fullscreen=[fullscreen("sv", "sf", module.PRODUCT_VS)]),
                   render("smaa-unpremultiply", "smaa-unpremultiply", ["l1"], ["aa-edges"], kind="unpremultiply_alpha")]
        # Later builders append character samplers after the SMAA ones.
        g["sampler_overrides"] = {"1:bf:0:4": samplers["1:bf:0:4"], "1:sf:0:4": dict(min_filter="nearest"), "1:uf:0:4": samplers["1:uf:0:4"]}
    g.update(output="l1", output_semantic="c4-l1-linear-straight", source_coordinate_policy=module.COORDINATES, full_frame_ready=True,
             frame_inputs=dict(capture_sha256="c" * 64, frame_index=60, time_seconds=2.0333334393799305, visible_draws=[0, 1], current_previous_validated=True,
                               producer_mode="native-source-programs", overrides=[dict(draw_index=0, resource=dict(set=0, binding=11, category="ubos", file="Objects/o.bytes", sha256="o", byte_count=16))],
                               state_overrides=[dict(draw_index=1, native_state=state())]),
             product_look=dict(profile="desktop-neutral-v1"))
    if fused:
        g["spatial_antialiasing"] = dict(kind="source-smaa-linear-premultiplied-v1", input="aa-input", premultiplied="aa-premultiplied", edges="aa-edges", output="l1")
        g["aa_product_profile"] = dict(coverage_edges=False)
        if additive:g["presentation_additive"] = "post-add"
    return json.loads(json.dumps(g))


FORBIDDEN_KEYS = {"vertex_adapter", "fragment_adapter", "source_coordinate_policy", "spatial_antialiasing", "aa_product_profile", "output", "output_semantic",
                  "presentation_additive", "product_look", "full_frame_ready", "capture_sha256", "frame_index", "time_seconds", "current_previous_validated",
                  "producer_mode", "positions", "key_order"}


def forbidden(scene):
    """Every scene element the task forbids: keys, smaa-* passes, aa-*/l1/post-add targets and textures, and any reference to them."""
    found = []
    def walk(v, path):
        if isinstance(v, dict):
            for k, x in v.items():
                if k in FORBIDDEN_KEYS:found.append(path + "/" + k)
                walk(x, path + "/" + k)
        elif isinstance(v, list):
            for i, x in enumerate(v):walk(x, "%s[%d]" % (path, i))
        elif isinstance(v, str) and (v.startswith("aa-") or v in ("l1", "post-add")):found.append("%s=%s" % (path, v))
    walk(scene, "")
    found += ["pass " + p["id"] for p in scene["passes"] if p["phase"].startswith("smaa-")]
    return found


class SyntheticTests(unittest.TestCase):
    def roundtrip(self, g):
        scene, metal, record = module.split(copy.deepcopy(g))
        # The files are JSON; the round trip must survive a reload.
        scene, metal, record = (json.loads(module.dumps(x)) for x in (scene, metal, record))
        self.assertEqual(module.dumps(module.emit_metal(scene, metal, record)), module.dumps(g))
        return scene, metal, record

    def test_plain_post(self):
        scene, metal, record = self.roundtrip(graph(fused=False))
        self.assertEqual(forbidden(scene), [])
        self.assertEqual([p["id"] for p in metal["passes"]], ["linearize-post"])
        self.assertNotIn("fused_post", metal)

    def test_fused(self):
        scene, metal, record = self.roundtrip(graph())
        self.assertEqual(forbidden(scene), [])
        self.assertEqual(metal["fused_post"], dict(fragment_adapter=module.FUSED))
        uber = next(p for p in scene["passes"] if p["phase"] == "uber-post")
        self.assertEqual([c["target"] for c in uber["colors"]], ["post-gamma"])
        self.assertIn(dict(id="post-gamma", width=8, height=8, format="rgba32Float"), scene["targets"])
        self.assertEqual(list(scene["sampler_overrides"]), ["1:bf:0:4", "1:uf:0:4"])
        self.assertEqual(scene["schema"], module.SCENE_SCHEMA)

    def test_fused_additive(self):
        scene, metal, record = self.roundtrip(graph(additive=True))
        self.assertEqual(forbidden(scene), [])
        self.assertEqual(metal["fused_post"], dict(fragment_adapter=module.FUSED_ADD, presentation_additive="post-add"))
        uber = next(p for p in scene["passes"] if p["phase"] == "uber-post")
        self.assertEqual(list(uber["fullscreen"][0]["native_state"]["blend"]), ["rtBlend0"])

    def test_unknown_keys(self):
        for where in ("top", "pass", "fullscreen", "frame_inputs"):
            g = graph()
            target = dict(top=g, frame_inputs=g["frame_inputs"], **{"pass": g["passes"][0], "fullscreen": g["passes"][1]["fullscreen"][0]})[where]
            target["mystery_" + where] = 1
            with self.assertRaisesRegex(ValueError, "mystery_" + where):module.split(g)

    def test_adapter_off_rule(self):
        g = graph(); g["passes"][1]["fullscreen"][0]["vertex_adapter"] = module.HELPER_VS
        with self.assertRaisesRegex(ValueError, "screen-shadow-resolve"):module.split(g)

    def test_scene_edit_follows(self):
        g = graph(additive=True); scene, metal, record = module.split(copy.deepcopy(g))
        scene["passes"][3]["fullscreen"][0]["resources"][0]["sha256"] = "edited"
        scene["frame_inputs"]["visible_draws"] = [1]
        out = module.emit_metal(scene, metal, record)
        self.assertEqual(out["passes"][3]["fullscreen"][0]["resources"][0]["sha256"], "edited")
        self.assertEqual(out["frame_inputs"]["visible_draws"], [1])
        g["passes"][3]["fullscreen"][0]["resources"][0]["sha256"] = "edited"; g["frame_inputs"]["visible_draws"] = [1]
        self.assertEqual(module.dumps(out), module.dumps(g))


if __name__ == "__main__":
    unittest.main()
