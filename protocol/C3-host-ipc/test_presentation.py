import unittest
import validate


class PresentationContractTests(unittest.TestCase):
    def test_normalized_provider_and_explicit_face_reset(self):
        m=dict(type='set_presentation',req=1,character='birch',weather=dict(condition='rain',intensity=.5),expression=dict(pose=None,weight=0))
        self.assertEqual(validate.check_presentation_request(m,None),[])
        for weather in [None,dict(condition='clear',intensity=.1),dict(condition='snow',intensity=float('nan')),dict(condition='rain',intensity=True),dict(condition='rain',intensity=.2,wetness=2)]:
            self.assertTrue(validate.check_presentation_request(dict(m,weather=weather),None))

    def test_receipt_requires_submitted_frame_and_adaptable_pose(self):
        m=dict(type='presentation_state',req=2,character='birch',phase='applied',frame=9,expressions=['source_pose'],expression='source_pose',weather_supported=True,face_effect_supported=True,coverage=dict(drops=.2,wetness=.3,snow=0))
        self.assertEqual(validate.check_presentation_state(m,None),[])
        for patch in [dict(frame=None),dict(expression='unsupported'),dict(expressions=['a','a']),dict(coverage=dict(drops=0,wetness=float('inf'),snow=0)),dict(weather_supported=1)]:
            self.assertTrue(validate.check_presentation_state(dict(m,**patch),None))

    def test_atlas_index_and_expiry_are_bounded(self):
        m=dict(type='set_presentation',req=3,character='birch',face_effect=dict(index=2,blend=.8),valid_for_seconds=3600)
        self.assertEqual(validate.check_presentation_request(m,None),[])
        self.assertTrue(validate.check_presentation_request(dict(m,face_effect=dict(index=4,blend=1)),None))
        self.assertTrue(validate.check_presentation_request(dict(m,valid_for_seconds=3601),None))

    def test_dynamic_facial_timeline_uses_exact_identity_and_normalized_inputs(self):
        m=dict(type='set_presentation',req=4,character='birch',facial_animation=dict(id='face_source',rate=.5,weight=.8))
        self.assertEqual(validate.check_presentation_request(m,None),[])
        self.assertEqual(validate.check_presentation_request(dict(m,facial_animation=dict(id=None)),None),[])
        for a in [dict(id=''),dict(id='a'*65),dict(id='source',rate=float('nan')),dict(id='source',rate=3),dict(id='source',weight=True)]:
            self.assertTrue(validate.check_presentation_request(dict(m,facial_animation=a),None))
        r=dict(type='presentation_state',req=4,character='birch',phase='applied',frame=20,expressions=[],expression=None,weather_supported=False,face_effect_supported=False,
               coverage=dict(drops=0,wetness=0,snow=0),facial_animations=[dict(id='face_source',name='original_name',duration=2)],facial_animation=dict(id='face_source',time=1,completed=False))
        self.assertEqual(validate.check_presentation_state(r,None),[])
        self.assertTrue(validate.check_presentation_state(dict(r,facial_animation=dict(id='foreign',time=0,completed=False)),None))


if __name__=='__main__':unittest.main()
