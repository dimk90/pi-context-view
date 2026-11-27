#!/bin/bash
#
# Record the Context Usage view once per pre-defined icon style and
# composite the stills side by side for the README customization demo.
#
# Every panel replays the same pinned session at the same size, so the only
# difference between them is the icon style. The one-frame GIF intermediates
# stay in doc/images/icon-styles/.
#
# Produces doc/images/icon-styles.png
#

set -uo pipefail

_ICON_STYLES_SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
_ICON_STYLES_REPO_ROOT=$(cd -- "$_ICON_STYLES_SCRIPT_DIR/.." && pwd)
readonly _ICON_STYLES_SCRIPT_DIR _ICON_STYLES_REPO_ROOT

readonly _ICON_STYLES_PANEL_DIR="$_ICON_STYLES_REPO_ROOT/doc/images/icon-styles"
readonly _ICON_STYLES_RECORDER="$_ICON_STYLES_SCRIPT_DIR/icon-style.rec.sh"
readonly _ICON_STYLES_OUTPUT="$_ICON_STYLES_REPO_ROOT/doc/images/icon-styles.png"

# The default style first, then the rest of the pre-defined ones
readonly _ICON_STYLES_NAMES=('Circle' 'CC' 'Nerd')

# agg's asciinema theme, the one the panels are rendered with
readonly _ICON_STYLES_BACKGROUND='#121314'
readonly _ICON_STYLES_FOREGROUND='#cccccc'
readonly _ICON_STYLES_CAPTION_FAMILY='Iosevka Term'
readonly _ICON_STYLES_CAPTION_SIZE=68
readonly _ICON_STYLES_GAP=24


main() {
    #
    # Record every icon style panel and composite them into the README image.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   ./scripts/icon-styles-panel.sh
    #
    _icon_styles_check_dependencies || return 1

    local icon_style
    for icon_style in "${_ICON_STYLES_NAMES[@]}"; do
        _icon_styles_record_panel "$icon_style" || return 1
        printf '\n'
    done

    _icon_styles_composite || return 1
    printf '::: Wrote %s (%s)\n' "$_ICON_STYLES_OUTPUT" "$(magick identify -format '%wx%h' "$_ICON_STYLES_OUTPUT")"
    printf '::: Review the image: the panels must differ only in map and legend glyphs\n'
}


## Internal
#
# Bash cannot hide these from a sourcing shell; the _icon_styles_ prefix marks
# the private boundary.


_icon_styles_check_dependencies() {
    #
    # Fail before the first recording when a required tool or font is missing.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _icon_styles_check_dependencies || return 1
    #
    command -v magick >/dev/null || { printf 'icon-styles: ImageMagick (magick) is not installed\n' >&2; return 1; }
    [[ -x $_ICON_STYLES_RECORDER ]] || {
        printf 'icon-styles: %s is not executable\n' "$_ICON_STYLES_RECORDER" >&2
        return 1
    }

    # Consume the full list so pipefail does not turn grep's early exit into failure
    magick -list font | grep "family: $_ICON_STYLES_CAPTION_FAMILY\$" >/dev/null || {
        printf 'icon-styles: font family %s is not available to ImageMagick\n' "$_ICON_STYLES_CAPTION_FAMILY" >&2
        return 1
    }
    return 0
}


_icon_styles_record_panel() {
    #
    # Record one icon style panel and verify its GIF exists and is nonempty.
    #
    # Parameters:
    #   $1 - icon_style - icon style name passed to the recorder.
    #
    # Example:
    #   _icon_styles_record_panel 'Circle' || return 1
    #
    local icon_style="$1"

    "$_ICON_STYLES_RECORDER" "$icon_style" || return 1
    [[ -s $_ICON_STYLES_PANEL_DIR/$icon_style.gif ]] || {
        printf 'icon-styles: %s panel GIF is missing or empty\n' "$icon_style" >&2
        return 1
    }
    return 0
}


_icon_styles_composite() {
    #
    # Caption each one-frame GIF in memory, then append the panels into one
    # padded image. Only the final composite is written as PNG.
    #
    # Parameters:
    #   None.
    #
    # Example:
    #   _icon_styles_composite || return 1
    #
    local panels=()
    local index
    for index in "${!_ICON_STYLES_NAMES[@]}"; do
        panels+=(
            '('
            -background "$_ICON_STYLES_BACKGROUND"
            -fill "$_ICON_STYLES_FOREGROUND"
            -family "$_ICON_STYLES_CAPTION_FAMILY"
            -pointsize "$_ICON_STYLES_CAPTION_SIZE"
            "$_ICON_STYLES_PANEL_DIR/${_ICON_STYLES_NAMES[index]}.gif[0]"
            "label:${_ICON_STYLES_NAMES[index]}"
            -gravity center
            -append
            ')'
        )
    done

    magick "${panels[@]}" -bordercolor "$_ICON_STYLES_BACKGROUND" -border "$_ICON_STYLES_GAP" \
           -background "$_ICON_STYLES_BACKGROUND" +append "$_ICON_STYLES_OUTPUT"
}


main "$@"
