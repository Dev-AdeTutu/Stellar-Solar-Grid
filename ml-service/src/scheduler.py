"""
Automated model retraining scheduler
Runs weekly to retrain models with latest data
"""

import os
import sys
import json
import urllib.request
import urllib.error
from datetime import datetime
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
import logging
import signal

from train import train_model

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('logs/scheduler.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class ModelRetrainingScheduler:
    """
    Scheduler for automated model retraining
    """
    
    def __init__(
        self,
        model_dir: str = './models',
        data_path: str = None,
        weather_api_key: str = None,
        lat: float = 37.7749,
        lon: float = -122.4194,
        cron_schedule: str = '0 2 * * 0',  # Default: Every Sunday at 2 AM
        edge_export_dir: str = None,
        backend_url: str = None,
        backend_api_key: str = None
    ):
        """
        Initialize scheduler
        
        Args:
            model_dir: Base directory for models
            data_path: Path to training data
            weather_api_key: Weather API key
            lat: Latitude for weather data
            lon: Longitude for weather data
            cron_schedule: Cron expression for scheduling
            edge_export_dir: Directory to export edge-optimized models to
            backend_url: Backend base URL for publishing edge model versions
            backend_api_key: API key for authenticating with the backend
        """
        self.model_dir = model_dir
        self.data_path = data_path
        self.weather_api_key = weather_api_key
        self.lat = lat
        self.lon = lon
        self.cron_schedule = cron_schedule
        self.edge_export_dir = edge_export_dir or os.path.join(model_dir, 'edge')
        self.backend_url = backend_url or os.environ.get('BACKEND_URL')
        self.backend_api_key = backend_api_key or os.environ.get('BACKEND_API_KEY')
        
        self.scheduler = BackgroundScheduler()
        self.is_running = False
        
    def retrain_job(self):
        """
        Job function to retrain models
        """
        logger.info("=" * 80)
        logger.info("SCHEDULED MODEL RETRAINING STARTED")
        logger.info(f"Timestamp: {datetime.now().isoformat()}")
        logger.info("=" * 80)
        
        try:
            # Create timestamped model directory
            timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
            versioned_model_dir = os.path.join(self.model_dir, f'version_{timestamp}')
            
            # Train model
            summary = train_model(
                data_path=self.data_path,
                model_dir=versioned_model_dir,
                epochs=100,
                batch_size=32,
                validation_split=0.2,
                test_split=0.1,
                weather_api_key=self.weather_api_key,
                lat=self.lat,
                lon=self.lon
            )
            
            # Check if training was successful
            if summary['all_horizons_pass']:
                logger.info(f"✓ Retraining successful! Models saved to {versioned_model_dir}")
                
                # Update 'latest' symlink
                latest_dir = os.path.join(self.model_dir, 'latest')
                
                # Remove old symlink if exists
                if os.path.exists(latest_dir):
                    if os.path.islink(latest_dir):
                        os.unlink(latest_dir)
                    elif os.path.isdir(latest_dir):
                        import shutil
                        shutil.rmtree(latest_dir)
                
                # Create new symlink (or copy on Windows if symlink fails)
                try:
                    os.symlink(versioned_model_dir, latest_dir)
                    logger.info(f"Updated 'latest' symlink to {versioned_model_dir}")
                except OSError:
                    # Fallback for Windows without admin rights
                    import shutil
                    shutil.copytree(versioned_model_dir, latest_dir)
                    logger.info(f"Copied model to 'latest' directory (symlink not available)")
                
                # Export edge-optimized model and notify backend so meters can update
                try:
                    edge_info = self.export_edge_model(versioned_model_dir, timestamp)
                    self.publish_edge_model(edge_info)
                except Exception as edge_error:
                    logger.error(f"Edge model export/publish failed: {edge_error}")
                    import traceback
                    logger.error(traceback.format_exc())
                
                # Cleanup old versions (keep last 5)
                self.cleanup_old_versions(keep=5)
                
                logger.info("Scheduled retraining completed successfully")
                
            else:
                logger.error("✗ Retraining failed - accuracy requirements not met")
                logger.error(f"Test results: {summary['test_results']}")
                
        except Exception as e:
            logger.error(f"Error during scheduled retraining: {e}")
            import traceback
            logger.error(traceback.format_exc())
        
        logger.info("=" * 80)
        logger.info("SCHEDULED MODEL RETRAINING ENDED")
        logger.info("=" * 80)
    
    def cleanup_old_versions(self, keep: int = 5):
        """
        Clean up old model versions, keeping only the most recent
        
        Args:
            keep: Number of versions to keep
        """
        try:
            versions = []
            
            for item in os.listdir(self.model_dir):
                if item.startswith('version_'):
                    path = os.path.join(self.model_dir, item)
                    if os.path.isdir(path):
                        versions.append((item, os.path.getmtime(path)))
            
            # Sort by modification time (newest first)
            versions.sort(key=lambda x: x[1], reverse=True)
            
            # Remove old versions
            for version_name, _ in versions[keep:]:
                version_path = os.path.join(self.model_dir, version_name)
                logger.info(f"Removing old version: {version_name}")
                
                import shutil
                shutil.rmtree(version_path)
            
            if len(versions) > keep:
                logger.info(f"Cleaned up {len(versions) - keep} old versions")
                
        except Exception as e:
            logger.error(f"Error cleaning up old versions: {e}")
    
    def export_edge_model(self, versioned_model_dir: str, timestamp: str) -> dict:
        """
        Export an edge-optimized model bundle for deployment to meter edge devices.
        
        Args:
            versioned_model_dir: Directory containing the newly trained models
            timestamp: Timestamp string used for the model version
            
        Returns:
            Dictionary describing the exported edge model
        """
        import shutil
        
        os.makedirs(self.edge_export_dir, exist_ok=True)
        edge_version = f'edge_{timestamp}'
        edge_version_dir = os.path.join(self.edge_export_dir, edge_version)
        
        # Copy trained model artifacts into the edge bundle directory
        if os.path.isdir(edge_version_dir):
            shutil.rmtree(edge_version_dir)
        shutil.copytree(versioned_model_dir, edge_version_dir)
        
        # Write edge manifest describing the bundle
        manifest = {
            'version': edge_version,
            'source_version': os.path.basename(versioned_model_dir),
            'created_at': datetime.now().isoformat(),
            'target': 'meter-edge',
            'artifacts': sorted(os.listdir(edge_version_dir))
        }
        manifest_path = os.path.join(edge_version_dir, 'edge_manifest.json')
        with open(manifest_path, 'w') as f:
            json.dump(manifest, f, indent=2)
        
        logger.info(f"Exported edge model bundle to {edge_version_dir}")
        
        return {
            'version': edge_version,
            'path': edge_version_dir,
            'manifest': manifest
        }
    
    def publish_edge_model(self, edge_info: dict):
        """
        Notify the backend of a new edge model version so meters can be updated.
        
        Args:
            edge_info: Edge model info returned by export_edge_model
        """
        if not self.backend_url:
            logger.warning(
                "No backend URL configured; skipping edge model publish notification"
            )
            return
        
        url = self.backend_url.rstrip('/') + '/api/edge/models'
        payload = json.dumps({
            'version': edge_info['version'],
            'source_version': edge_info['manifest']['source_version'],
            'created_at': edge_info['manifest']['created_at'],
            'target': edge_info['manifest']['target'],
            'artifacts': edge_info['manifest']['artifacts']
        }).encode('utf-8')
        
        request = urllib.request.Request(
            url,
            data=payload,
            method='POST',
            headers={'Content-Type': 'application/json'}
        )
        if self.backend_api_key:
            request.add_header('Authorization', f'Bearer {self.backend_api_key}')
        
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                status = response.status
                body = response.read().decode('utf-8', errors='replace')
            logger.info(
                f"Published edge model {edge_info['version']} to backend "
                f"(status={status}): {body}"
            )
        except urllib.error.HTTPError as e:
            logger.error(
                f"Backend rejected edge model publish for {edge_info['version']}: "
                f"{e.code} {e.reason}"
            )
            raise
        except urllib.error.URLError as e:
            logger.error(
                f"Failed to reach backend to publish edge model "
                f"{edge_info['version']}: {e.reason}"
            )
            raise
    
    def start(self):
        """Start the scheduler"""
        if self.is_running:
            logger.warning("Scheduler is already running")
            return
        
        # Add the retraining job
        self.scheduler.add_job(
            self.retrain_job,
            trigger=CronTrigger.from_crontab(self.cron_schedule),
            id='model_retraining',
            name='Model Retraining Job',
            replace_existing=True
        )
        
        logger.info(f"Scheduled model retraining with cron: {self.cron_schedule}")
        
        # Also run immediately on startup (optional, commented out by default)
        # self.scheduler.add_job(
        #     self.retrain_job,
        #     'date',
        #     run_date=datetime.now(),
        #     id='initial_training',
        #     name='Initial Training'
        # )
        
        self.scheduler.start()
        self.is_running = True
        
        logger.info("Model retraining scheduler started")
        logger.info(f"Next retraining scheduled for: {self.scheduler.get_job('model_retraining').next_run_time}")
    
    def stop(self):
        """Stop the scheduler"""
        if not self.is_running:
            return
        
        logger.info("Stopping model retraining scheduler...")
        self.scheduler.shutdown()
        self.is_running = False
        logger.info("Scheduler stopped")
    
    def trigger_manual_retrain(self):
        """Manually trigger a retraining job"""
        logger.info("Manual retraining triggered")
        self.retrain_job()


def main():
    """Main entry point for scheduler service"""
    import argparse
    
    parser = argparse.ArgumentParser(
        description='Automated model retraining scheduler'
    )
    
    parser.add_argument(
        '--model-dir',
        type=str,
        default='./models',
        help='Base directory for models'
    )
    
    parser.add_argument(
        '--data-path',
        type=str,
        default=None,
        help='Path to training data'
    )
    
    parser.add_argument(
        '--weather-api-key',
        type=str,
        default=None,
        help='Weather API key'
    )
    
    parser.add_argument(
        '--lat',
        type=float,
        default=37.7749,
        help='Latitude for weather data'
    )
    
    parser.add_argument(
        '--lon',
        type=float,
        default=-122.4194,
        help='Longitude for weather data'
    )
    
    parser.add_argument(
        '--cron',
        type=str,
        default='0 2 * * 0',
        help='Cron schedule (default: Every Sunday at 2 AM)'
    )
    
    parser.add_argument(
        '--run-now',
        action='store_true',
        help='Run retraining immediately on startup'
    )
    
    parser.add_argument(
        '--edge-export-dir',
        type=str,
        default=None,
        help='Directory to export edge-optimized models to (default: <model-dir>/edge)'
    )
    
    parser.add_argument(
        '--backend-url',
        type=str,
        default=None,
        help='Backend base URL for publishing edge model versions (default: $BACKEND_URL)'
    )
    
    parser.add_argument(
        '--backend-api-key',
        type=str,
        default=None,
        help='API key for backend authentication (default: $BACKEND_API_KEY)'
    )
    
    args = parser.parse_args()
    
    # Create logs directory
    os.makedirs('logs', exist_ok=True)
    
    # Create scheduler
    scheduler = ModelRetrainingScheduler(
        model_dir=args.model_dir,
        data_path=args.data_path,
        weather_api_key=args.weather_api_key,
        lat=args.lat,
        lon=args.lon,
        cron_schedule=args.cron,
        edge_export_dir=args.edge_export_dir,
        backend_url=args.backend_url,
        backend_api_key=args.backend_api_key
    )
    
    # Set up signal handlers for graceful shutdown
    def signal_handler(signum, frame):
        logger.info(f"Received signal {signum}, shutting down...")
        scheduler.stop()
        sys.exit(0)
    
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    # Start scheduler
    scheduler.start()
    
    # Run immediately if requested
    if args.run_now:
        logger.info("Running initial retraining as requested...")
        scheduler.trigger_manual_retrain()
    
    # Keep the program running
    logger.info("Scheduler is running. Press Ctrl+C to stop.")
    
    try:
        # Keep alive
        while True:
            import time
            time.sleep(1)
    except KeyboardInterrupt:
        logger.info("Keyboard interrupt received")
        scheduler.stop()


if __name__ == '__main__':
    main()
