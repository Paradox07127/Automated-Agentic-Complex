/* fbx-motion: the motion of an FBX file as per-frame node_to_world matrices, read with ufbx.
 *
 *   fbx-motion --version
 *   fbx-motion probe <source>
 *   fbx-motion sample <source> --take N --fps F --out <file>
 *
 * probe and --version print one JSON line on stdout. sample writes <file>: one JSON line
 * {"nodes":[{"name","parent"}],"frames":F}, then (F + 1) x nodes x 12 little-endian float64,
 * each matrix 3x4 row-major; matrix set 0 is the unevaluated scene, set k + 1 the take at
 * time_begin + k / fps. A failure prints {"error":reason,"detail":text} on stderr and exits 2.
 * Axes and units are left as the file has them.
 */
#include "ufbx.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>

#define MAX_BYTES (256.0 * 1024 * 1024)
#define MAX_SAMPLES 4000000.0 /* frames x nodes, as the glTF importer */

static void json_string(FILE *out, const char *text, size_t length)
{
	size_t i;
	fputc('"', out);
	for (i = 0; i < length; i++) {
		unsigned char c = (unsigned char)text[i];
		if (c == '"' || c == '\\') fprintf(out, "\\%c", c);
		else if (c < 0x20) fprintf(out, "\\u%04x", c);
		else fputc(c, out);
	}
	fputc('"', out);
}

static void fail(const char *reason, const char *detail)
{
	fprintf(stderr, "{\"error\":\"%s\",\"detail\":", reason);
	json_string(stderr, detail, strlen(detail));
	fputs("}\n", stderr);
	exit(2);
}

static void usage(void)
{
	fputs("usage: fbx-motion --version | probe <source> | sample <source> --take N --fps F --out <file>\n", stderr);
	exit(1);
}

static void cannot_write(const char *path)
{
	fprintf(stderr, "fbx-motion: cannot write %s\n", path);
	exit(1);
}

static ufbx_scene *load(const char *path)
{
	struct stat info;
	ufbx_load_opts opts = { 0 };
	ufbx_error error;
	ufbx_scene *scene;
	char detail[512];

	if (stat(path, &info) != 0) fail("bad_source", "cannot read the file");
	if ((double)info.st_size > MAX_BYTES) fail("bad_source", "file_size");
	opts.ignore_geometry = true;
	opts.ignore_embedded = true;
	scene = ufbx_load_file(path, &opts, &error);
	if (!scene) {
		snprintf(detail, sizeof(detail), "%s%s%s", error.description.data, error.info_length ? ": " : "", error.info);
		fail("bad_source", detail);
	}
	return scene;
}

static void axis_vector(ufbx_coordinate_axis axis, double v[3])
{
	v[0] = v[1] = v[2] = 0;
	v[axis / 2] = axis % 2 ? -1 : 1;
}

/* ufbx's front is the opposite of forward, so right x up = front in a right-handed file. */
static int right_handed(ufbx_coordinate_axes axes)
{
	double r[3], u[3], f[3];
	if (!ufbx_coordinate_axes_valid(axes)) return 0;
	axis_vector(axes.right, r);
	axis_vector(axes.up, u);
	axis_vector(axes.front, f);
	return r[1] * u[2] - r[2] * u[1] == f[0] && r[2] * u[0] - r[0] * u[2] == f[1] && r[0] * u[1] - r[1] * u[0] == f[2];
}

static const char *axis_name(ufbx_coordinate_axis axis)
{
	static const char *names[] = { "+X", "-X", "+Y", "-Y", "+Z", "-Z" };
	return axis < UFBX_COORDINATE_AXIS_UNKNOWN ? names[axis] : "unknown";
}

static int probe(const char *path)
{
	ufbx_scene *scene = load(path);
	const ufbx_scene_settings *s = &scene->settings;
	size_t i;

	printf("{\"version\":%u,\"axes\":{\"right\":\"%s\",\"up\":\"%s\",\"front\":\"%s\"},\"right_handed\":%s,"
	       "\"unit_meters\":%.17g,\"frames_per_second\":%.17g,\"takes\":[",
	       scene->metadata.version, axis_name(s->axes.right), axis_name(s->axes.up), axis_name(s->axes.front),
	       right_handed(s->axes) ? "true" : "false", (double)s->unit_meters, s->frames_per_second);
	for (i = 0; i < scene->anim_stacks.count; i++) {
		const ufbx_anim_stack *stack = scene->anim_stacks.data[i];
		printf("%s{\"index\":%zu,\"name\":", i ? "," : "", i);
		json_string(stdout, stack->name.data, stack->name.length);
		printf(",\"time_begin\":%.17g,\"time_end\":%.17g}", stack->time_begin, stack->time_end);
	}
	puts("]}");
	ufbx_free_scene(scene);
	return 0;
}

static int write_matrix(FILE *out, const ufbx_matrix *m)
{
	double row[12];
	int r, c;
	for (r = 0; r < 3; r++)
		for (c = 0; c < 4; c++) row[r * 4 + c] = (double)m->v[c * 3 + r];
	return fwrite(row, sizeof(double), 12, out) == 12;
}

static int sample(const char *path, long take, double fps, const char *out_path)
{
	ufbx_scene *scene = load(path);
	const ufbx_anim_stack *stack;
	size_t count = scene->nodes.count, kept = 0, i, k, frames;
	long *index = malloc((count ? count : 1) * sizeof(long));
	ufbx_node **nodes = malloc((count ? count : 1) * sizeof(ufbx_node *));
	FILE *out;

	if (!index || !nodes) fail("bad_source", "out of memory");
	if (!right_handed(scene->settings.axes)) fail("left_handed_axes", "the file's axes are not right-handed");
	if (scene->anim_stacks.count == 0) fail("no_animation", "the file has no animation stack");
	if (take < 0 || (size_t)take >= scene->anim_stacks.count) fail("take", "no such animation stack");
	stack = scene->anim_stacks.data[take];
	if (!(stack->time_end >= stack->time_begin)) fail("bad_source", "the animation stack ends before it starts");
	frames = (size_t)floor((stack->time_end - stack->time_begin) * fps + 1e-9) + 1;
	for (i = 0; i < count; i++) {
		ufbx_node *node = scene->nodes.data[i];
		index[i] = -1;
		if (node->is_root || node->is_geometry_transform_helper || node->is_scale_helper) continue;
		index[i] = (long)kept;
		nodes[kept++] = node;
	}
	if ((double)frames * (double)kept > MAX_SAMPLES) fail("too_long", "too many frames x nodes");

	out = fopen(out_path, "wb");
	if (!out) cannot_write(out_path);
	fputs("{\"nodes\":[", out);
	for (k = 0; k < kept; k++) {
		const ufbx_node *parent = nodes[k]->parent;
		while (parent && index[parent->typed_id] < 0) parent = parent->parent;
		fputs(k ? ",{\"name\":" : "{\"name\":", out);
		json_string(out, nodes[k]->name.data, nodes[k]->name.length);
		fprintf(out, ",\"parent\":%ld}", parent ? index[parent->typed_id] : -1L);
	}
	fprintf(out, "],\"frames\":%zu}\n", frames);
	for (k = 0; k < kept; k++)
		if (!write_matrix(out, &nodes[k]->node_to_world)) cannot_write(out_path);
	for (i = 0; i < frames; i++) {
		ufbx_error error;
		ufbx_scene *state = ufbx_evaluate_scene(scene, stack->anim, stack->time_begin + (double)i / fps, NULL, &error);
		if (!state) fail("bad_source", error.description.data);
		for (k = 0; k < kept; k++)
			if (!write_matrix(out, &state->nodes.data[nodes[k]->typed_id]->node_to_world)) cannot_write(out_path);
		ufbx_free_scene(state);
	}
	if (fclose(out) != 0) cannot_write(out_path);
	free(index);
	free(nodes);
	ufbx_free_scene(scene);
	return 0;
}

int main(int argc, char **argv)
{
	long take = 0;
	double fps = 30;
	const char *out = NULL;
	int i;
	char *end;

	if (argc == 2 && !strcmp(argv[1], "--version")) {
		printf("{\"tool\":\"fbx-motion/1\",\"ufbx\":\"%u.%u.%u\"}\n", ufbx_version_major(UFBX_HEADER_VERSION),
		       ufbx_version_minor(UFBX_HEADER_VERSION), ufbx_version_patch(UFBX_HEADER_VERSION));
		return 0;
	}
	if (argc == 3 && !strcmp(argv[1], "probe")) return probe(argv[2]);
	if (argc < 3 || strcmp(argv[1], "sample")) usage();
	for (i = 3; i + 1 < argc; i += 2) {
		if (!strcmp(argv[i], "--take")) take = strtol(argv[i + 1], &end, 10);
		else if (!strcmp(argv[i], "--fps")) fps = strtod(argv[i + 1], &end);
		else if (!strcmp(argv[i], "--out")) { out = argv[i + 1]; end = argv[i + 1] + strlen(argv[i + 1]); }
		else usage();
		if (*end) usage();
	}
	if (i != argc || !out || !(fps > 0)) usage();
	return sample(argv[2], take, fps, out);
}
