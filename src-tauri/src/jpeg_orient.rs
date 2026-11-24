//! Lossless JPEG rotation: instead of re-encoding the compressed image (which loses
//! quality every time), Chud Image rewrites the EXIF `Orientation` tag. Every modern
//! viewer, browser, operating system and photo service honours that tag.
//!
//! Three situations are handled without touching the image data itself:
//! 1. The tag already exists: its two bytes are patched in place.
//! 2. There is an EXIF block without the tag: a copy of IFD0 with the extra entry is
//!    appended to the EXIF block and the TIFF header is pointed at it. Every other offset
//!    stays valid because no existing byte moves.
//! 3. There is no EXIF block: a minimal one containing only the tag is inserted.

use crate::error::{AppError, AppResult};

const TAG_ORIENTATION: u16 = 0x0112;
const TYPE_SHORT: u16 = 3;
const EXIF_HEADER: &[u8] = b"Exif\0\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Endian {
    Little,
    Big,
}

impl Endian {
    fn u16(self, b: &[u8]) -> u16 {
        match self {
            Endian::Little => u16::from_le_bytes([b[0], b[1]]),
            Endian::Big => u16::from_be_bytes([b[0], b[1]]),
        }
    }
    fn u32(self, b: &[u8]) -> u32 {
        match self {
            Endian::Little => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            Endian::Big => u32::from_be_bytes([b[0], b[1], b[2], b[3]]),
        }
    }
    fn put_u16(self, v: u16) -> [u8; 2] {
        match self {
            Endian::Little => v.to_le_bytes(),
            Endian::Big => v.to_be_bytes(),
        }
    }
    fn put_u32(self, v: u32) -> [u8; 4] {
        match self {
            Endian::Little => v.to_le_bytes(),
            Endian::Big => v.to_be_bytes(),
        }
    }
}

struct ExifSegment {
    /// Offset of the 0xFF of the APP1 marker.
    seg_start: usize,
    /// Offset just past the end of the segment.
    seg_end: usize,
    /// Offset of the TIFF header ("II*\0" / "MM\0*").
    tiff_start: usize,
}

fn be16(b: &[u8], at: usize) -> usize {
    u16::from_be_bytes([b[at], b[at + 1]]) as usize
}

/// Locates the EXIF APP1 segment and the position where a new one should be inserted.
fn find_exif(jpeg: &[u8]) -> AppResult<(Option<ExifSegment>, usize)> {
    if jpeg.len() < 4 || jpeg[0] != 0xFF || jpeg[1] != 0xD8 {
        return Err(AppError::corrupt("not a JPEG file"));
    }
    let len = jpeg.len();
    let mut pos = 2;
    let mut insert_at = 2;
    loop {
        if pos >= len {
            break;
        }
        if jpeg[pos] != 0xFF {
            return Err(AppError::corrupt("JPEG marker expected"));
        }
        while pos < len && jpeg[pos] == 0xFF {
            pos += 1;
        }
        if pos >= len {
            break;
        }
        let marker = jpeg[pos];
        let marker_start = pos - 1;
        pos += 1;
        match marker {
            0x01 | 0xD0..=0xD8 => continue,
            0xD9 | 0xDA => break,
            _ => {}
        }
        if pos + 2 > len {
            return Err(AppError::corrupt("truncated JPEG segment"));
        }
        let seg_len = be16(jpeg, pos);
        if seg_len < 2 || pos + seg_len > len {
            return Err(AppError::corrupt("invalid JPEG segment length"));
        }
        let data_start = pos + 2;
        let end = pos + seg_len;
        if marker == 0xE1 && jpeg[data_start..end].starts_with(EXIF_HEADER) {
            return Ok((
                Some(ExifSegment {
                    seg_start: marker_start,
                    seg_end: end,
                    tiff_start: data_start + EXIF_HEADER.len(),
                }),
                insert_at,
            ));
        }
        // JFIF requires APP0 to stay first, so a new EXIF block goes after it.
        if marker == 0xE0 && marker_start == insert_at {
            insert_at = end;
        }
        pos = end;
    }
    Ok((None, insert_at))
}

struct Ifd0 {
    endian: Endian,
    offset: usize,
    count: usize,
}

fn parse_tiff(tiff: &[u8]) -> AppResult<Ifd0> {
    if tiff.len() < 8 {
        return Err(AppError::corrupt("EXIF block too short"));
    }
    let endian = match &tiff[0..2] {
        b"II" => Endian::Little,
        b"MM" => Endian::Big,
        _ => return Err(AppError::corrupt("invalid EXIF byte order")),
    };
    if endian.u16(&tiff[2..4]) != 42 {
        return Err(AppError::corrupt("invalid EXIF header"));
    }
    let offset = endian.u32(&tiff[4..8]) as usize;
    if offset + 2 > tiff.len() {
        return Err(AppError::corrupt("EXIF IFD0 out of bounds"));
    }
    let count = endian.u16(&tiff[offset..offset + 2]) as usize;
    if offset + 2 + count * 12 + 4 > tiff.len() {
        return Err(AppError::corrupt("EXIF IFD0 truncated"));
    }
    Ok(Ifd0 { endian, offset, count })
}

fn orientation_entry(tiff: &[u8], ifd: &Ifd0) -> Option<usize> {
    (0..ifd.count)
        .map(|i| ifd.offset + 2 + i * 12)
        .find(|&e| ifd.endian.u16(&tiff[e..e + 2]) == TAG_ORIENTATION)
}

/// Reads the EXIF orientation (1–8) of a JPEG, defaulting to 1 (normal).
pub fn read_orientation(jpeg: &[u8]) -> u16 {
    let Ok((Some(seg), _)) = find_exif(jpeg) else { return 1 };
    let tiff = &jpeg[seg.tiff_start..seg.seg_end];
    let Ok(ifd) = parse_tiff(tiff) else { return 1 };
    match orientation_entry(tiff, &ifd) {
        Some(e) => {
            let v = ifd.endian.u16(&tiff[e + 8..e + 10]);
            if (1..=8).contains(&v) {
                v
            } else {
                1
            }
        }
        None => 1,
    }
}

/// Returns a copy of `jpeg` whose EXIF orientation is `orientation`; the compressed
/// image data is copied byte for byte.
pub fn set_orientation(jpeg: &[u8], orientation: u16) -> AppResult<Vec<u8>> {
    if !(1..=8).contains(&orientation) {
        return Err(AppError::corrupt(format!("invalid orientation {orientation}")));
    }
    let (segment, insert_at) = find_exif(jpeg)?;
    let Some(seg) = segment else {
        let app1 = minimal_exif_segment(orientation);
        let mut out = Vec::with_capacity(jpeg.len() + app1.len());
        out.extend_from_slice(&jpeg[..insert_at]);
        out.extend_from_slice(&app1);
        out.extend_from_slice(&jpeg[insert_at..]);
        return Ok(out);
    };

    let tiff = &jpeg[seg.tiff_start..seg.seg_end];
    let ifd = parse_tiff(tiff)?;
    let endian = ifd.endian;

    if let Some(entry) = orientation_entry(tiff, &ifd) {
        let mut out = jpeg.to_vec();
        let at = seg.tiff_start + entry;
        // Normalise the entry to SHORT/1 and write the value.
        out[at + 2..at + 4].copy_from_slice(&endian.put_u16(TYPE_SHORT));
        out[at + 4..at + 8].copy_from_slice(&endian.put_u32(1));
        out[at + 8..at + 10].copy_from_slice(&endian.put_u16(orientation));
        out[at + 10..at + 12].copy_from_slice(&[0, 0]);
        return Ok(out);
    }

    // Append a new IFD0 = old entries + orientation, sorted by tag as TIFF requires.
    let entries_start = ifd.offset + 2;
    let mut entries: Vec<[u8; 12]> = (0..ifd.count)
        .map(|i| {
            let mut e = [0u8; 12];
            e.copy_from_slice(&tiff[entries_start + i * 12..entries_start + i * 12 + 12]);
            e
        })
        .collect();
    let next_ifd = &tiff[entries_start + ifd.count * 12..entries_start + ifd.count * 12 + 4];
    let new_entry = orientation_ifd_entry(endian, orientation);
    let pos = entries
        .iter()
        .position(|e| endian.u16(&e[0..2]) > TAG_ORIENTATION)
        .unwrap_or(entries.len());
    entries.insert(pos, new_entry);

    let mut new_tiff = tiff.to_vec();
    if new_tiff.len() % 2 == 1 {
        new_tiff.push(0);
    }
    let new_offset = new_tiff.len() as u32;
    new_tiff.extend_from_slice(&endian.put_u16(entries.len() as u16));
    for e in &entries {
        new_tiff.extend_from_slice(e);
    }
    new_tiff.extend_from_slice(next_ifd);
    new_tiff[4..8].copy_from_slice(&endian.put_u32(new_offset));

    let seg_len = 2 + EXIF_HEADER.len() + new_tiff.len();
    if seg_len > u16::MAX as usize {
        return Err(AppError::unsupported("EXIF block too large to extend"));
    }
    let mut out = Vec::with_capacity(jpeg.len() + entries.len() * 12 + 8);
    out.extend_from_slice(&jpeg[..seg.seg_start]);
    out.extend_from_slice(&[0xFF, 0xE1]);
    out.extend_from_slice(&(seg_len as u16).to_be_bytes());
    out.extend_from_slice(EXIF_HEADER);
    out.extend_from_slice(&new_tiff);
    out.extend_from_slice(&jpeg[seg.seg_end..]);
    Ok(out)
}

/// Copies the EXIF block of `source` (if any) into `target`, a freshly encoded JPEG
/// without EXIF, and resets the orientation to 1 because the pixels are now upright.
/// Camera, date, GPS… survive an edit this way. The embedded thumbnail does not: it still
/// shows the picture before the edit (an area cropped away or painted over would stay
/// visible in it), so it is wiped. When that cannot be done safely, this fails and the
/// caller saves without EXIF. With `strip_gps` the location goes too.
pub fn transplant_exif(source: &[u8], target: &[u8], strip_gps: bool) -> AppResult<Vec<u8>> {
    let Ok((Some(seg), _)) = find_exif(source) else { return Ok(target.to_vec()) };
    let (existing, insert_at) = find_exif(target)?;
    if existing.is_some() {
        return set_orientation(target, 1);
    }
    let mut segment = source[seg.seg_start..seg.seg_end].to_vec();
    let tiff = &mut segment[seg.tiff_start - seg.seg_start..];
    drop_thumbnail(tiff)?;
    if strip_gps {
        drop_gps(tiff)?;
    }
    let mut out = Vec::with_capacity(target.len() + segment.len());
    out.extend_from_slice(&target[..insert_at]);
    out.extend_from_slice(&segment);
    out.extend_from_slice(&target[insert_at..]);
    set_orientation(&out, 1)
}

const TAG_GPS_IFD: u16 = 0x8825;
const TAG_STRIP_OFFSETS: u16 = 0x0111;
const TAG_STRIP_BYTE_COUNTS: u16 = 0x0117;
const TAG_THUMB_OFFSET: u16 = 0x0201;
const TAG_THUMB_LENGTH: u16 = 0x0202;

/// Unlinks IFD1 (the thumbnail directory) from a TIFF block and zeroes the thumbnail
/// bytes, so that they cannot be found by following the tags nor by scanning the file.
/// No byte moves: every other offset stays valid.
fn drop_thumbnail(tiff: &mut [u8]) -> AppResult<()> {
    let ifd0 = parse_tiff(tiff)?;
    let e = ifd0.endian;
    let next_at = ifd0.offset + 2 + ifd0.count * 12;
    let ifd1 = e.u32(&tiff[next_at..next_at + 4]) as usize;
    if ifd1 == 0 {
        return Ok(());
    }
    if ifd1 + 2 > tiff.len() {
        return Err(AppError::corrupt("EXIF IFD1 out of bounds"));
    }
    let count = e.u16(&tiff[ifd1..ifd1 + 2]) as usize;
    if ifd1 + 2 + count * 12 > tiff.len() {
        return Err(AppError::corrupt("EXIF IFD1 truncated"));
    }
    // A single LONG or SHORT value, stored in the entry itself.
    let value = |tiff: &[u8], tag: u16| -> Option<usize> {
        (0..count).map(|i| ifd1 + 2 + i * 12).find(|&at| e.u16(&tiff[at..at + 2]) == tag).and_then(|at| {
            let n = e.u32(&tiff[at + 4..at + 8]);
            match e.u16(&tiff[at + 2..at + 4]) {
                4 if n == 1 => Some(e.u32(&tiff[at + 8..at + 12]) as usize),
                3 if n == 1 => Some(e.u16(&tiff[at + 8..at + 10]) as usize),
                _ => None,
            }
        })
    };
    let has = |tiff: &[u8], tag: u16| (0..count).any(|i| e.u16(&tiff[ifd1 + 2 + i * 12..]) == tag);
    let mut wipe = Vec::new();
    for (offset_tag, length_tag) in [(TAG_THUMB_OFFSET, TAG_THUMB_LENGTH), (TAG_STRIP_OFFSETS, TAG_STRIP_BYTE_COUNTS)] {
        match (value(tiff, offset_tag), value(tiff, length_tag)) {
            (Some(at), Some(len)) if at.checked_add(len).is_some_and(|end| end <= tiff.len()) => wipe.push(at..at + len),
            // Present but not understood (several strips, bad bounds): don't keep it.
            _ if has(tiff, offset_tag) => return Err(AppError::corrupt("unexpected EXIF thumbnail layout")),
            _ => {}
        }
    }
    for range in wipe {
        tiff[range].fill(0);
    }
    tiff[next_at..next_at + 4].copy_from_slice(&e.put_u32(0));
    Ok(())
}

fn orientation_ifd_entry(endian: Endian, orientation: u16) -> [u8; 12] {
    let mut e = [0u8; 12];
    e[0..2].copy_from_slice(&endian.put_u16(TAG_ORIENTATION));
    e[2..4].copy_from_slice(&endian.put_u16(TYPE_SHORT));
    e[4..8].copy_from_slice(&endian.put_u32(1));
    e[8..10].copy_from_slice(&endian.put_u16(orientation));
    e
}

fn minimal_exif_segment(orientation: u16) -> Vec<u8> {
    let mut tiff = Vec::with_capacity(26);
    tiff.extend_from_slice(b"MM\0\x2A");
    tiff.extend_from_slice(&8u32.to_be_bytes());
    tiff.extend_from_slice(&1u16.to_be_bytes());
    tiff.extend_from_slice(&orientation_ifd_entry(Endian::Big, orientation));
    tiff.extend_from_slice(&0u32.to_be_bytes());
    let seg_len = (2 + EXIF_HEADER.len() + tiff.len()) as u16;
    let mut seg = vec![0xFF, 0xE1];
    seg.extend_from_slice(&seg_len.to_be_bytes());
    seg.extend_from_slice(EXIF_HEADER);
    seg.extend_from_slice(&tiff);
    seg
}

/// Size in bytes of one value of a TIFF field type.
fn type_size(field_type: u16) -> Option<usize> {
    match field_type {
        1 | 2 | 6 | 7 => Some(1),
        3 | 8 => Some(2),
        4 | 9 | 11 => Some(4),
        5 | 10 | 12 => Some(8),
        _ => None,
    }
}

/// Removes the location: the GPS directory and every value it points to are zeroed and
/// its entry is taken out of IFD0. No other byte moves, so every other offset stays valid.
fn drop_gps(tiff: &mut [u8]) -> AppResult<()> {
    let ifd0 = parse_tiff(tiff)?;
    let e = ifd0.endian;
    let entry_at = |i: usize| ifd0.offset + 2 + i * 12;
    let Some(index) = (0..ifd0.count).find(|&i| e.u16(&tiff[entry_at(i)..]) == TAG_GPS_IFD) else {
        return Ok(());
    };
    let gps = e.u32(&tiff[entry_at(index) + 8..]) as usize;
    let bad = || AppError::corrupt("unexpected EXIF GPS layout");
    if gps + 2 > tiff.len() {
        return Err(bad());
    }
    let count = e.u16(&tiff[gps..]) as usize;
    let dir_end = gps + 2 + count * 12 + 4;
    if dir_end > tiff.len() {
        return Err(bad());
    }
    // Values longer than four bytes live elsewhere in the block: wipe them first.
    let mut wipe = Vec::new();
    wipe.push(gps..dir_end);
    for i in 0..count {
        let at = gps + 2 + i * 12;
        let size = type_size(e.u16(&tiff[at + 2..])).ok_or_else(bad)?;
        let len = size.checked_mul(e.u32(&tiff[at + 4..]) as usize).ok_or_else(bad)?;
        if len > 4 {
            let start = e.u32(&tiff[at + 8..]) as usize;
            let end = start.checked_add(len).filter(|&end| end <= tiff.len()).ok_or_else(bad)?;
            wipe.push(start..end);
        }
    }
    for range in wipe {
        tiff[range].fill(0);
    }
    // Take the pointer out of IFD0: later entries and the next-IFD offset move up one slot.
    let from = entry_at(index + 1);
    let to = entry_at(ifd0.count) + 4;
    tiff.copy_within(from..to, entry_at(index));
    tiff[to - 12..to].fill(0);
    let count_at = ifd0.offset;
    let new_count = e.put_u16((ifd0.count - 1) as u16);
    tiff[count_at..count_at + 2].copy_from_slice(&new_count);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use image::{ImageFormat, Rgb, RgbImage};
    use std::io::Cursor;

    pub fn sample_jpeg() -> Vec<u8> {
        let img = RgbImage::from_fn(48, 32, |x, y| Rgb([(x * 5) as u8, (y * 7) as u8, 128]));
        let mut out = Cursor::new(Vec::new());
        img.write_to(&mut out, ImageFormat::Jpeg).unwrap();
        out.into_inner()
    }

    fn exif_orientation(jpeg: &[u8]) -> Option<u32> {
        let exif = exif::Reader::new().read_from_container(&mut Cursor::new(jpeg)).ok()?;
        exif.get_field(exif::Tag::Orientation, exif::In::PRIMARY)?.value.get_uint(0)
    }

    fn exif_make(jpeg: &[u8]) -> Option<String> {
        let exif = exif::Reader::new().read_from_container(&mut Cursor::new(jpeg)).ok()?;
        let f = exif.get_field(exif::Tag::Make, exif::In::PRIMARY)?;
        Some(f.display_value().to_string())
    }

    fn pixels(jpeg: &[u8]) -> Vec<u8> {
        image::load_from_memory_with_format(jpeg, ImageFormat::Jpeg).unwrap().to_rgb8().into_raw()
    }

    /// Builds a JPEG whose EXIF block has a `Make` tag but no orientation.
    fn jpeg_with_make_only(endian: Endian) -> Vec<u8> {
        let base = sample_jpeg();
        let mut tiff = Vec::new();
        tiff.extend_from_slice(if endian == Endian::Little { b"II" } else { b"MM" });
        tiff.extend_from_slice(&endian.put_u16(42));
        tiff.extend_from_slice(&endian.put_u32(8));
        tiff.extend_from_slice(&endian.put_u16(1));
        tiff.extend_from_slice(&endian.put_u16(0x010F)); // Make
        tiff.extend_from_slice(&endian.put_u16(2)); // ASCII
        tiff.extend_from_slice(&endian.put_u32(6));
        tiff.extend_from_slice(&endian.put_u32(26)); // value offset
        tiff.extend_from_slice(&endian.put_u32(0));
        tiff.extend_from_slice(b"Chud!\0");
        let mut seg = vec![0xFF, 0xE1];
        seg.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        seg.extend_from_slice(EXIF_HEADER);
        seg.extend_from_slice(&tiff);
        let (_, insert_at) = find_exif(&base).unwrap();
        let mut out = base[..insert_at].to_vec();
        out.extend_from_slice(&seg);
        out.extend_from_slice(&base[insert_at..]);
        out
    }

    #[test]
    fn inserts_exif_when_missing() {
        let jpeg = sample_jpeg();
        assert_eq!(read_orientation(&jpeg), 1);
        let rotated = set_orientation(&jpeg, 6).unwrap();
        assert_eq!(read_orientation(&rotated), 6);
        assert_eq!(exif_orientation(&rotated), Some(6));
        assert_eq!(pixels(&jpeg), pixels(&rotated), "image data must be untouched");
    }

    #[test]
    fn patches_existing_tag_in_place() {
        let once = set_orientation(&sample_jpeg(), 6).unwrap();
        let twice = set_orientation(&once, 3).unwrap();
        assert_eq!(once.len(), twice.len());
        assert_eq!(exif_orientation(&twice), Some(3));
    }

    #[test]
    fn adds_tag_to_existing_exif_and_keeps_other_tags() {
        for endian in [Endian::Little, Endian::Big] {
            let jpeg = jpeg_with_make_only(endian);
            assert_eq!(exif_make(&jpeg).as_deref(), Some("\"Chud!\""));
            let rotated = set_orientation(&jpeg, 8).unwrap();
            assert_eq!(exif_orientation(&rotated), Some(8));
            assert_eq!(exif_make(&rotated).as_deref(), Some("\"Chud!\""));
            assert_eq!(pixels(&jpeg), pixels(&rotated));
        }
    }

    /// A JPEG whose EXIF block has a `Make` tag in IFD0 and `thumb` as IFD1 thumbnail.
    fn jpeg_with_thumbnail(endian: Endian, thumb: &[u8]) -> Vec<u8> {
        let base = sample_jpeg();
        let e = endian;
        let mut tiff = Vec::new();
        tiff.extend_from_slice(if e == Endian::Little { b"II" } else { b"MM" });
        tiff.extend_from_slice(&e.put_u16(42));
        tiff.extend_from_slice(&e.put_u32(8));
        // IFD0 at 8: Make → "Chud!" at 26, next IFD at 32.
        tiff.extend_from_slice(&e.put_u16(1));
        tiff.extend_from_slice(&e.put_u16(0x010F));
        tiff.extend_from_slice(&e.put_u16(2));
        tiff.extend_from_slice(&e.put_u32(6));
        tiff.extend_from_slice(&e.put_u32(26));
        tiff.extend_from_slice(&e.put_u32(32));
        tiff.extend_from_slice(b"Chud!\0");
        // IFD1 at 32: thumbnail offset + length, thumbnail data at 62.
        tiff.extend_from_slice(&e.put_u16(2));
        for (tag, v) in [(TAG_THUMB_OFFSET, 62u32), (TAG_THUMB_LENGTH, thumb.len() as u32)] {
            tiff.extend_from_slice(&e.put_u16(tag));
            tiff.extend_from_slice(&e.put_u16(4));
            tiff.extend_from_slice(&e.put_u32(1));
            tiff.extend_from_slice(&e.put_u32(v));
        }
        tiff.extend_from_slice(&e.put_u32(0));
        assert_eq!(tiff.len(), 62);
        tiff.extend_from_slice(thumb);
        let mut seg = vec![0xFF, 0xE1];
        seg.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        seg.extend_from_slice(EXIF_HEADER);
        seg.extend_from_slice(&tiff);
        let (_, insert_at) = find_exif(&base).unwrap();
        let mut out = base[..insert_at].to_vec();
        out.extend_from_slice(&seg);
        out.extend_from_slice(&base[insert_at..]);
        out
    }

    fn has_thumbnail(jpeg: &[u8]) -> bool {
        let exif = exif::Reader::new().read_from_container(&mut Cursor::new(jpeg)).unwrap();
        exif.get_field(exif::Tag::JPEGInterchangeFormat, exif::In::THUMBNAIL).is_some()
    }

    /// The thumbnail of the unedited photo must not travel into the edited one: it would
    /// still show what was cropped away or painted over.
    #[test]
    fn edits_drop_the_old_embedded_thumbnail() {
        let thumb = sample_jpeg();
        for endian in [Endian::Little, Endian::Big] {
            let source = jpeg_with_thumbnail(endian, &thumb);
            assert!(has_thumbnail(&source));
            let edited = transplant_exif(&source, &sample_jpeg(), false).unwrap();
            assert!(!has_thumbnail(&edited), "IFD1 still linked");
            assert!(!edited.windows(thumb.len()).any(|w| w == thumb.as_slice()), "thumbnail bytes still in the file");
            assert_eq!(exif_make(&edited).as_deref(), Some("\"Chud!\""), "other tags survive");
            assert_eq!(read_orientation(&edited), 1);
        }
    }

    #[test]
    fn a_thumbnail_it_cannot_locate_means_no_exif_at_all() {
        let mut source = jpeg_with_thumbnail(Endian::Little, &sample_jpeg());
        // Point the thumbnail far outside the EXIF block.
        let tiff = source.windows(6).position(|w| w == EXIF_HEADER).unwrap() + 6;
        // IFD1 sits at 32 in the TIFF block; its first entry is the thumbnail offset.
        let at = tiff + 34;
        assert_eq!(u16::from_le_bytes([source[at], source[at + 1]]), TAG_THUMB_OFFSET);
        source[at + 8..at + 12].copy_from_slice(&0x00FF_FFFFu32.to_le_bytes());
        assert!(transplant_exif(&source, &sample_jpeg(), false).is_err());
    }

    /// A JPEG with `Make` and a GPS directory holding a latitude (out-of-line rationals).
    fn jpeg_with_gps(endian: Endian) -> Vec<u8> {
        let base = sample_jpeg();
        let e = endian;
        let mut tiff = Vec::new();
        tiff.extend_from_slice(if e == Endian::Little { b"II" } else { b"MM" });
        tiff.extend_from_slice(&e.put_u16(42));
        tiff.extend_from_slice(&e.put_u32(8));
        // IFD0 at 8, two entries: Make → 38, GPS IFD → 44. Ends at 8 + 2 + 24 + 4 = 38.
        tiff.extend_from_slice(&e.put_u16(2));
        tiff.extend_from_slice(&e.put_u16(0x010F));
        tiff.extend_from_slice(&e.put_u16(2));
        tiff.extend_from_slice(&e.put_u32(6));
        tiff.extend_from_slice(&e.put_u32(38));
        tiff.extend_from_slice(&e.put_u16(TAG_GPS_IFD));
        tiff.extend_from_slice(&e.put_u16(4));
        tiff.extend_from_slice(&e.put_u32(1));
        tiff.extend_from_slice(&e.put_u32(44));
        tiff.extend_from_slice(&e.put_u32(0));
        tiff.extend_from_slice(b"Chud!\0");
        // GPS IFD at 44: LatitudeRef "N" (inline), Latitude 3 rationals at 74.
        tiff.extend_from_slice(&e.put_u16(2));
        tiff.extend_from_slice(&e.put_u16(0x0001));
        tiff.extend_from_slice(&e.put_u16(2));
        tiff.extend_from_slice(&e.put_u32(2));
        tiff.extend_from_slice(b"N\0\0\0");
        tiff.extend_from_slice(&e.put_u16(0x0002));
        tiff.extend_from_slice(&e.put_u16(5));
        tiff.extend_from_slice(&e.put_u32(3));
        tiff.extend_from_slice(&e.put_u32(74));
        tiff.extend_from_slice(&e.put_u32(0));
        assert_eq!(tiff.len(), 74);
        for (num, den) in [(48u32, 1u32), (51, 1), (123_456, 10_000)] {
            tiff.extend_from_slice(&e.put_u32(num));
            tiff.extend_from_slice(&e.put_u32(den));
        }
        let mut seg = vec![0xFF, 0xE1];
        seg.extend_from_slice(&((2 + 6 + tiff.len()) as u16).to_be_bytes());
        seg.extend_from_slice(EXIF_HEADER);
        seg.extend_from_slice(&tiff);
        let (_, insert_at) = find_exif(&base).unwrap();
        let mut out = base[..insert_at].to_vec();
        out.extend_from_slice(&seg);
        out.extend_from_slice(&base[insert_at..]);
        out
    }

    fn latitude(jpeg: &[u8]) -> Option<String> {
        let exif = exif::Reader::new().read_from_container(&mut Cursor::new(jpeg)).ok()?;
        Some(exif.get_field(exif::Tag::GPSLatitude, exif::In::PRIMARY)?.display_value().to_string())
    }

    #[test]
    fn edits_can_leave_the_location_out() {
        for endian in [Endian::Little, Endian::Big] {
            let source = jpeg_with_gps(endian);
            assert!(latitude(&source).is_some());
            // Kept by default...
            let kept = transplant_exif(&source, &sample_jpeg(), false).unwrap();
            assert!(latitude(&kept).is_some());
            // ...and gone, values included, on request.
            let stripped = transplant_exif(&source, &sample_jpeg(), true).unwrap();
            assert_eq!(latitude(&stripped), None);
            assert!(!stripped.windows(4).any(|w| w == e_bytes(endian, 123_456)), "latitude bytes still in the file");
            assert_eq!(exif_make(&stripped).as_deref(), Some("\"Chud!\""), "other tags survive");
            assert_eq!(read_orientation(&stripped), 1);
        }
    }

    fn e_bytes(endian: Endian, v: u32) -> [u8; 4] {
        endian.put_u32(v)
    }

    #[test]
    fn a_gps_directory_out_of_bounds_means_no_exif_at_all() {
        let mut source = jpeg_with_gps(Endian::Little);
        let tiff = source.windows(6).position(|w| w == EXIF_HEADER).unwrap() + 6;
        // Second IFD0 entry (the GPS pointer) at 8 + 2 + 12; its value at +8.
        let at = tiff + 22;
        assert_eq!(u16::from_le_bytes([source[at], source[at + 1]]), TAG_GPS_IFD);
        source[at + 8..at + 12].copy_from_slice(&0x00FF_FFFFu32.to_le_bytes());
        assert!(transplant_exif(&source, &sample_jpeg(), true).is_err());
        // Without stripping the pointer is never followed.
        assert!(transplant_exif(&source, &sample_jpeg(), false).is_ok());
    }

    #[test]
    fn rejects_non_jpeg_and_bad_values() {
        assert!(set_orientation(b"not a jpeg", 1).is_err());
        assert!(set_orientation(&sample_jpeg(), 9).is_err());
        assert!(set_orientation(&sample_jpeg(), 0).is_err());
    }
}
