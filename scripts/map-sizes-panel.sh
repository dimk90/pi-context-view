#!/bin/bash
#
# Record the Context Usage view at three map sizes and composite captioned
# stills side by side for the map-size customization demo.
# All panels use the same pinned session, terminal size, font, and palette.
# Produces doc/images/map-sizes.png; intermediates stay in doc/images/map-sizes/.
#

set -uo pipefail

_MAP_SIZES_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
_MAP_SIZES_REPO_ROOT=$(cd -- "$_MAP_SIZES_SCRIPT_DIR/.." && pwd)
readonly _MAP_SIZES_SCRIPT_DIR _MAP_SIZES_REPO_ROOT

readonly _MAP_SIZES_PANEL_DIR="$_MAP_SIZES_REPO_ROOT/doc/images/map-sizes"
readonly _MAP_SIZES_RECORDER="$_MAP_SIZES_SCRIPT_DIR/map-size.rec.sh"
readonly _MAP_SIZES_OUTPUT="$_MAP_SIZES_REPO_ROOT/doc/images/map-sizes.png"

# Empty dimensions reserve the first panel for clean-config defaults
readonly _MAP_SIZES_ROWS=('' 22 22)
readonly _MAP_SIZES_COLS=('' 8 22)

# Match the palette composite and agg's asciinema theme
readonly _MAP_SIZES_BACKGROUND='#121314'
readonly _MAP_SIZES_FOREGROUND='#cccccc'
readonly _MAP_SIZES_CAPTION_FONT='Iosevka-Term-Medium-Extended'
readonly _MAP_SIZES_CAPTION_SIZE=48
readonly _MAP_SIZES_GAP=24


main() {
    #
    # Record and verify all three sizes, then compose the customization image.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   ./scripts/map-sizes-panel.sh
    #
    _map_sizes_check_dependencies || return 1

    local index
    for index in "${!_MAP_SIZES_ROWS[@]}"; do
        if [[ $index -eq 0 ]]; then
            _map_sizes_record_panel || return 1
        else
            _map_sizes_record_panel "${_MAP_SIZES_ROWS[index]}" "${_MAP_SIZES_COLS[index]}" || return 1
        fi
        printf '\n'
    done

    _map_sizes_composite || return 1
    printf '::: Wrote %s (%s)\n' "$_MAP_SIZES_OUTPUT" "$(magick identify -format '%wx%h' "$_MAP_SIZES_OUTPUT")"
    printf '::: Review the image: the panels must differ only in map geometry and derived layout\n'
}


## Internal
#
# Bash cannot hide these from a sourcing shell; _map_sizes_ marks the private
# boundary.


_map_sizes_check_dependencies() {
    #
    # Fail before recording if a required tool, recorder, or caption font is missing.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _map_sizes_check_dependencies || return 1
    #
    local dependency

    for dependency in curl tmux asciinema agg pi magick; do
        command -v "$dependency" >/dev/null || {
            printf 'map-sizes: %s is not installed\n' "$dependency" >&2
            return 1
        }
    done

    [[ -x $_MAP_SIZES_RECORDER ]] || {
        printf 'map-sizes: %s is not executable\n' "$_MAP_SIZES_RECORDER" >&2
        return 1
    }

    # Consume the full list so pipefail does not turn grep's early exit into failure
    magick -list font | grep "Font: $_MAP_SIZES_CAPTION_FONT\$" >/dev/null || {
        printf 'map-sizes: font %s is not available to ImageMagick\n' "$_MAP_SIZES_CAPTION_FONT" >&2
        return 1
    }

    return 0
}


_map_sizes_record_panel() {
    #
    # Record one geometry (or clean-config defaults with no arguments) and
    # verify its GIF exists and is nonempty.
    #
    # Parameters:
    #   $1 - rows - (optional) - map row count; requires cols.
    #   $2 - cols - (optional) - map column count; requires rows.
    #
    # Example:
    #   _map_sizes_record_panel 22 8 || return 1
    #
    local rows="${1-}"
    local cols="${2-}"
    local size='default'

    if [[ $# -ne 0 ]]; then
        size="${rows}x${cols}"
    fi
    "$_MAP_SIZES_RECORDER" "$@" || return 1
    [[ -s $_MAP_SIZES_PANEL_DIR/$size.gif ]] || {
        printf 'map-sizes: %s panel GIF is missing or empty\n' "$size" >&2
        return 1
    }

    return 0
}


_map_sizes_composite() {
    #
    # Caption each still in memory, then append the padded panels into one PNG.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _map_sizes_composite || return 1
    #
    local panels=()
    local index
    local caption
    local size

    for index in "${!_MAP_SIZES_ROWS[@]}"; do
        size="${_MAP_SIZES_ROWS[index]}x${_MAP_SIZES_COLS[index]}"
        caption="${_MAP_SIZES_COLS[index]} × ${_MAP_SIZES_ROWS[index]}"
        if [[ $index -eq 0 ]]; then
            size='default'
            caption='default'
        fi
        panels+=(
            '('
            -background "$_MAP_SIZES_BACKGROUND"
            -fill "$_MAP_SIZES_FOREGROUND"
            -font "$_MAP_SIZES_CAPTION_FONT"
            -pointsize "$_MAP_SIZES_CAPTION_SIZE"
            "$_MAP_SIZES_PANEL_DIR/$size.gif[0]"
            "label:$caption"
            -gravity center
            -append
            ')'
        )
    done

    magick "${panels[@]}" -bordercolor "$_MAP_SIZES_BACKGROUND" -border "$_MAP_SIZES_GAP" \
           -background "$_MAP_SIZES_BACKGROUND" +append "$_MAP_SIZES_OUTPUT"
}


main "$@"
