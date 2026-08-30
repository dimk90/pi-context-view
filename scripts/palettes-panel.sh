#!/bin/bash
#
# Record the Context Usage view once per example category palette and
# composite the three stills side by side for the README customization demo.
#
# Every panel replays the same pinned session at the same size, so the only
# difference between them is the palette. The one-frame GIF intermediates stay
# in doc/images/palettes/.
#
# Produces doc/images/color-palettes.png
#

set -uo pipefail

_PALETTES_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
_PALETTES_REPO_ROOT=$(cd -- "$_PALETTES_SCRIPT_DIR/.." && pwd)
readonly _PALETTES_SCRIPT_DIR _PALETTES_REPO_ROOT

readonly _PALETTES_PANEL_DIR="$_PALETTES_REPO_ROOT/doc/images/palettes"
readonly _PALETTES_RECORDER="$_PALETTES_SCRIPT_DIR/recordings/palette.rec.sh"
readonly _PALETTES_OUTPUT="$_PALETTES_REPO_ROOT/doc/images/palettes.png"

readonly _PALETTES_NAMES=('default' 'terrain' 'rainbow')
readonly _PALETTES_CAPTIONS=('default' 'terrain' 'rainbow')

# agg's asciinema theme, the one the panels are rendered with
readonly _PALETTES_BACKGROUND='#121314'
readonly _PALETTES_FOREGROUND='#cccccc'
readonly _PALETTES_CAPTION_FONT='Iosevka-Term-Medium-Extended'
readonly _PALETTES_CAPTION_SIZE=38
readonly _PALETTES_GAP=24


main() {
    #
    # Record every palette panel and composite them into the README image.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   ./scripts/palettes.sh
    #
    _palettes_check_dependencies || return 1

    local palette
    for palette in "${_PALETTES_NAMES[@]}"; do
        _palettes_record_panel "$palette" || return 1
    done

    _palettes_composite || return 1
    printf '::: Wrote %s (%s)\n' "$_PALETTES_OUTPUT" "$(identify -format '%wx%h' "$_PALETTES_OUTPUT")"
    printf '::: Review the image: the panels must differ only in color\n'
}


## Internal
#
# Bash cannot hide these from a sourcing shell; the _palettes_ prefix marks the
# private boundary.


_palettes_check_dependencies() {
    #
    # Fail before the first recording when a required tool or font is missing.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _palettes_check_dependencies || return 1
    #
    command -v magick >/dev/null || { printf 'palettes: ImageMagick (magick) is not installed\n' >&2; return 1; }
    [[ -x $_PALETTES_RECORDER ]] || { printf 'palettes: %s is not executable\n' "$_PALETTES_RECORDER" >&2; return 1; }
    magick -list font | grep -q "Font: $_PALETTES_CAPTION_FONT\$" || {
        printf 'palettes: font %s is not available to ImageMagick\n' "$_PALETTES_CAPTION_FONT" >&2
        return 1
    }
    return 0
}


_palettes_record_panel() {
    #
    # Record one palette panel and verify it reached the usage view.
    #
    # Parameters:
    #   $1 - palette - palette name passed to the recorder.
    #
    # Example:
    #   _palettes_record_panel 'terrain' || return 1
    #
    local palette="$1"

    "$_PALETTES_RECORDER" "$palette" || return 1
    [[ -s $_PALETTES_PANEL_DIR/$palette.gif ]] || {
        printf 'palettes: %s panel GIF is missing or empty\n' "$palette" >&2
        return 1
    }
    return 0
}


_palettes_composite() {
    #
    # Caption each one-frame GIF in memory, then append the panels into one
    # padded image. Only the final composite is written as PNG.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _palettes_composite || return 1
    #
    local panels=()
    local index
    for index in "${!_PALETTES_NAMES[@]}"; do
        panels+=(
            '('
            -background "$_PALETTES_BACKGROUND"
            -fill "$_PALETTES_FOREGROUND"
            -font "$_PALETTES_CAPTION_FONT"
            -pointsize "$_PALETTES_CAPTION_SIZE"
            "$_PALETTES_PANEL_DIR/${_PALETTES_NAMES[index]}.gif[0]"
            "label:${_PALETTES_CAPTIONS[index]}"
            -gravity center
            -append
            ')'
        )
    done

    magick "${panels[@]}" -bordercolor "$_PALETTES_BACKGROUND" -border "$_PALETTES_GAP" \
           -background "$_PALETTES_BACKGROUND" +append "$_PALETTES_OUTPUT"
}


main "$@"
