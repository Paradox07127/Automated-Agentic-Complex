#!/usr/bin/env python3
"""Import a motion source (VMD, BVH, glTF, VRMA) onto existing characters and publish a new offline library generation.

Each character goes through motion_import.pipeline.import_file, the entry the app's motion_tool uses, and
<output>/import-result.json holds one endfield-motion-import/v1 result per character. The input library is never
mutated; see docs/guides/motion-import.md.
"""
from pathlib import Path
import argparse
import datetime
import json
import shutil
import sys

from character_library import Package, Library, read_json, write_json, need, export_package
from resource_store import clone_or_copy
from agentic_complex_build.motion_import import pipeline, take


def main():
    p=argparse.ArgumentParser(description=__doc__)
    for key in ['library','source','output']:p.add_argument('--'+key,type=Path,required=True)
    p.add_argument('--character',action='append',required=True,help='repeat for several existing characters')
    p.add_argument('--format',choices=['auto',*take.FORMATS],default='auto')
    p.add_argument('--take',type=int,default=0,help='animation index in a multi-animation glTF')
    p.add_argument('--title');p.add_argument('--bgm',type=Path);p.add_argument('--bgm-start',type=float)
    p.add_argument('--no-foot-lock',action='store_true')
    p.add_argument('--bone-map',type=Path,help='JSON {canonical joint: source bone}, bvh and gltf only')
    p.add_argument('--export',action='store_true')
    a=p.parse_args();need(not a.output.exists(),'output_already_exists')
    need(not a.output.resolve().is_relative_to(a.library.resolve()),'output_inside_input_library')
    need(len(set(a.character))==len(a.character),'duplicate_character')
    bone_map=read_json(a.bone_map) if a.bone_map else None
    packages=Library(a.library).packages();by={x.id:x for x in packages};need(set(a.character).issubset(by),'unknown_character')
    a.output.mkdir(parents=True);results=[];selected={}
    try:
        for cid in a.character:
            target=a.output/'packages-built'/cid
            parts=pipeline.import_file(by[cid].root,a.source,a.format,target,take=a.take,title=a.title,bgm=a.bgm,
                                       bgm_start=a.bgm_start,foot_lock=not a.no_foot_lock,bone_map=bone_map)
            created_at=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
            results.append(take.build_result(character=cid,version=Package(target).version,created_at=created_at,**parts))
            selected[cid]=target
            if a.export:export_package(target,a.output/(cid+'.endfield-character'))
        library=Library(a.output/'library');library.root.mkdir()
        built=[]
        # Real APFS clones, as import_vmd.main publishes: never links into the input library.
        for original in packages:
            source=Package(selected.get(original.id,original.root))
            destination=library.root/'packages'/source.id/source.sha256
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copytree(source.root,destination,symlinks=True,copy_function=clone_or_copy)
            built.append(Package(destination,deep=False))
        default=Library(a.library).snapshot()['default_character']
        library.publish(sorted(built,key=lambda package:(package.id!=default,package.id)))
        write_json(a.output/'import-result.json',results)
        print(json.dumps(results,ensure_ascii=False))
    except BaseException:
        shutil.rmtree(a.output);raise
    return 0


if __name__=='__main__':sys.exit(main())
