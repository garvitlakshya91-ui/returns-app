import { useRef, useState } from 'react';
import { Camera, X } from 'lucide-react';
import { PHOTO_TYPES, PHOTO_MAX_BYTES, photoFileType as fileType } from '../photoTypes';

export default function PhotoUploader({ photos = [], onChange, maxPhotos = 3 }) {
  const fileInputRef = useRef(null);
  const [problem, setProblem] = useState('');

  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    const rejected = [];
    const accepted = [];
    for (const file of files) {
      if (!PHOTO_TYPES.includes(fileType(file))) rejected.push(`${file.name} isn't a JPEG, PNG, WebP or HEIC image`);
      else if (file.size > PHOTO_MAX_BYTES) rejected.push(`${file.name} is over 5MB`);
      else accepted.push(file);
    }
    const room = Math.max(0, maxPhotos - photos.length);
    if (accepted.length > room) rejected.push(`Only ${maxPhotos} photos per item`);
    const newPhotos = accepted.slice(0, room).map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      name: file.name,
    }));
    setProblem(rejected.join('. '));
    if (newPhotos.length) onChange([...photos, ...newPhotos]);
    e.target.value = '';
  }

  function removePhoto(index) {
    const updated = photos.filter((_, i) => i !== index);
    onChange(updated);
  }

  return (
    <div>
      <div className="flex flex-wrap gap-3">
        {photos.map((photo, i) => (
          <div key={i} className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-200">
            <img src={photo.preview} alt={photo.name} className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={() => removePhoto(i)}
              className="absolute top-0.5 right-0.5 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center"
              aria-label={`Remove ${photo.name}`}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}

        {photos.length < maxPhotos && (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-20 h-20 rounded-lg border-2 border-dashed border-gray-300 flex flex-col items-center justify-center text-gray-400 hover:border-indigo-400 hover:text-indigo-500 transition-colors"
          >
            <Camera className="w-5 h-5" />
            <span className="text-xs mt-1">Add</span>
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept={`${PHOTO_TYPES.join(',')},.heic,.heif`}
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />

      {problem ? (
        <p className="text-xs text-red-600 mt-2" role="alert">{problem}.</p>
      ) : (
        <p className="text-xs text-gray-400 mt-2">
          {photos.length}/{maxPhotos} photos (JPEG, PNG, WebP or HEIC, up to 5MB). Help us process your return faster.
        </p>
      )}
    </div>
  );
}
