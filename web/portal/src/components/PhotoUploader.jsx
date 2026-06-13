import { useState, useRef } from 'react';
import { Camera, X, Upload } from 'lucide-react';

export default function PhotoUploader({ photos = [], onChange, maxPhotos = 3 }) {
  const fileInputRef = useRef(null);

  function handleFileSelect(e) {
    const files = Array.from(e.target.files);
    const newPhotos = files.slice(0, maxPhotos - photos.length).map((file) => ({
      file,
      preview: URL.createObjectURL(file),
      name: file.name,
    }));
    onChange([...photos, ...newPhotos]);
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
        accept="image/*"
        multiple
        onChange={handleFileSelect}
        className="hidden"
      />

      <p className="text-xs text-gray-400 mt-2">
        {photos.length}/{maxPhotos} photos. Help us process your return faster.
      </p>
    </div>
  );
}
