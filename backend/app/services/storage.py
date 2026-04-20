"""
Storage Service
Handles GCS operations for CleanShot sessions and enhanced images.
"""

import structlog
from google.cloud import storage
from app.config import settings


logger = structlog.get_logger()


class StorageService:
    """Service for Google Cloud Storage operations."""
    
    def __init__(self):
        self.client = storage.Client(project=settings.gcp_project_id)
        self.sessions_bucket = self.client.bucket(settings.gcs_sessions_bucket)
        self.references_bucket = self.client.bucket(settings.gcs_references_bucket)
    
    async def save_enhanced_image(
        self, 
        image_data: bytes, 
        original_uri: str,
        enhancement_level: str
    ) -> str:
        """
        Save an enhanced image to the sessions bucket.
        
        Args:
            image_data: Raw image bytes from Gemini
            original_uri: Original image GCS URI
            enhancement_level: Enhancement level applied
            
        Returns:
            GCS URI of the saved enhanced image
        """
        # Extract filename from original URI
        original_filename = original_uri.split('/')[-1]
        base_name = original_filename.rsplit('.', 1)[0]
        
        # Generate enhanced filename
        enhanced_filename = f"{base_name}_enhanced_{enhancement_level}.jpg"
        blob_path = f"enhanced/{enhanced_filename}"
        
        # Save to GCS
        blob = self.sessions_bucket.blob(blob_path)
        blob.upload_from_string(image_data, content_type="image/jpeg")
        
        enhanced_uri = f"gs://{settings.gcs_sessions_bucket}/{blob_path}"
        
        logger.info("Enhanced image saved",
                    original_uri=original_uri,
                    enhanced_uri=enhanced_uri,
                    level=enhancement_level)
        
        return enhanced_uri
